import crypto from "crypto";
import fetch from "node-fetch";
import { config } from "../config";
import { providers } from "../providers";
import { createLogger } from "../utils/logger";
import { computePHash, isDuplicate } from "../utils/phash";
import { computeColorSignature, colorSignatureDistance } from "../utils/colorSignature";
import { BackdropCandidate, ParsedIds, ProviderImage, ProviderName } from "../types";
import * as store from "./store";

const log = createLogger("backdropPool");

// Prevents concurrent refresh sweeps from stacking up for the same title
// if requests come in faster than a sweep finishes.
const sweepInFlight = new Set<string>();

export function buildContentKey(ids: ParsedIds): string {
  return `${ids.type ?? "x"}|tmdb:${ids.tmdbId ?? ""}|tvdb:${ids.tvdbId ?? ""}`;
}

function candidateIdFor(url: string): string {
  return crypto.createHash("md5").update(url).digest("hex").slice(0, 16);
}

/** Filters out backdrops whose resolution is bad relative to the best one in the same batch. */
function filterByResolution(images: ProviderImage[]): ProviderImage[] {
  if (images.length === 0) return images;
  const maxWidth = Math.max(...images.map((i) => i.width || 0));
  const floor = Math.max(config.backdrop.minAbsoluteWidth, maxWidth * config.backdrop.minRelativeWidth);
  return images.filter((i) => (i.width || 0) >= floor);
}

async function fetchCandidates(providerName: ProviderName, ids: ParsedIds): Promise<BackdropCandidate[]> {
  const provider = providers[providerName];
  const raw = await provider.getBackdrops({
    tmdbId: ids.tmdbId,
    tvdbId: ids.tvdbId,
    type: ids.type,
    language: null,
    limit: config.backdrop.fetchLimit,
  });
  const filtered = filterByResolution(raw);
  return filtered.map((img) => ({
    ...img,
    id: candidateIdFor(img.url),
  }));
}

async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ensureSignatures(candidate: BackdropCandidate): Promise<{ phash: string; colorSig: number[] }> {
  const cached = store.getCachedPhash(candidate.id);
  if (cached && cached.colorSig) return { phash: cached.phash, colorSig: cached.colorSig };
  const bytes = await downloadImage(candidate.url);
  const [hash, colorSig] = await Promise.all([computePHash(bytes), computeColorSignature(bytes)]);
  store.setCachedPhash(candidate.id, hash, colorSig);
  return { phash: hash, colorSig };
}

function quality(c: Pick<BackdropCandidate, "width" | "height">): number {
  return (c.width || 0) * (c.height || 0);
}

/**
 * Checks a-vs-b for duplication, using the global known-pairs cache first.
 *
 * Requires BOTH signals to agree before calling it a duplicate:
 *  - pHash (DCT-based, frequency/structure similarity) within the Hamming
 *    threshold - catches recolored/recompressed/slightly-cropped repeats
 *    of the same shot
 *  - the spatial color signature within its distance threshold - catches
 *    cases where pHash alone would false-positive on two structurally
 *    similar but genuinely different shots (e.g. two different wide
 *    shots of a similarly-lit spaceship corridor)
 *
 * Requiring agreement between two differently-biased signals is more
 * reliable than either alone - pHash by itself can conflate different
 * scenes that share strong edges/composition, and a color histogram by
 * itself can conflate scenes that just share a similar palette.
 */
async function checkDuplicate(a: BackdropCandidate, b: BackdropCandidate): Promise<boolean> {
  const known = store.getKnownDuplicateResult(a.id, b.id);
  if (known !== null) return known;

  const sigA = a.phash && a.colorSig ? { phash: a.phash, colorSig: a.colorSig } : await ensureSignatures(a);
  const sigB = b.phash && b.colorSig ? { phash: b.phash, colorSig: b.colorSig } : await ensureSignatures(b);
  a.phash = sigA.phash;
  a.colorSig = sigA.colorSig;
  b.phash = sigB.phash;
  b.colorSig = sigB.colorSig;

  const hashClose = isDuplicate(sigA.phash, sigB.phash, config.backdrop.dedupHammingThreshold);
  const colorClose = colorSignatureDistance(sigA.colorSig, sigB.colorSig) <= config.backdrop.dedupColorSigMaxDistance;
  const result = hashClose && colorClose;

  store.setKnownDuplicateResult(a.id, b.id, result);
  return result;
}

/**
 * Seeds a brand-new pool fast (no hashing yet) so the very first request
 * for a title has something to serve immediately. Full dedup + backfill
 * happens afterwards via refreshPool(), in the background.
 *
 * In "both" mode, BACKDROP_POOL_TARGET_SIZE applies PER PROVIDER (e.g. 6
 * means "up to 6 from TMDB and up to 6 from TVDB", not 6 total) - each
 * provider is only asked to dig deeper into its own results later if its
 * own contribution loses candidates to dedup, per refreshPool() below.
 * In "main-backup" mode it's a single overall target, and the backup
 * provider is only consulted if the main provider falls short.
 */
export async function ensureInitialPool(ids: ParsedIds): Promise<BackdropCandidate[]> {
  const contentKey = buildContentKey(ids);
  const existing = store.getPool(contentKey).filter((c) => !c.rejected);
  if (existing.length > 0) return existing;

  store.upsertContentMeta(contentKey, ids.tmdbId, ids.tvdbId, ids.type);

  if (config.backdrop.mode === "both") {
    const [mainRaw, backupRaw] = await Promise.all([
      fetchCandidates(config.backdrop.mainProvider, ids),
      fetchCandidates(config.backdrop.backupProvider, ids),
    ]);
    const initial = [
      ...mainRaw.slice(0, config.backdrop.poolTargetSize),
      ...backupRaw.slice(0, config.backdrop.poolTargetSize),
    ];
    for (const c of initial) store.upsertCandidate(contentKey, { ...c, rejected: false });
  } else {
    const mainRaw = await fetchCandidates(config.backdrop.mainProvider, ids);
    const initial = mainRaw.slice(0, config.backdrop.poolTargetSize);
    for (const c of initial) store.upsertCandidate(contentKey, { ...c, rejected: false });

    if (initial.length === 0) {
      // Main provider gave literally nothing usable - fall back to backup
      // immediately so the very first request isn't a 404.
      const backupRaw = await fetchCandidates(config.backdrop.backupProvider, ids);
      const backupInitial = backupRaw.slice(0, config.backdrop.poolTargetSize);
      for (const c of backupInitial) store.upsertCandidate(contentKey, { ...c, rejected: false });
    }
  }

  return store.getPool(contentKey).filter((c) => !c.rejected);
}

/**
 * Full background sweep: hash everything, dedupe, and backfill from
 * main (then backup, if configured/needed) until the pool is back at
 * target size or providers are exhausted.
 */
export async function refreshPool(ids: ParsedIds): Promise<void> {
  const contentKey = buildContentKey(ids);
  if (sweepInFlight.has(contentKey)) return;
  sweepInFlight.add(contentKey);

  try {
    store.upsertContentMeta(contentKey, ids.tmdbId, ids.tvdbId, ids.type);
    let pool = store.getPool(contentKey);
    let accepted = pool.filter((c) => !c.rejected);

    // 1. Hash everything that doesn't have a hash yet.
    for (const c of accepted) {
      if (!c.phash) {
        try {
          const sig = await ensureSignatures(c);
          c.phash = sig.phash;
          c.colorSig = sig.colorSig;
          store.upsertCandidate(contentKey, { ...c, rejected: false });
        } catch (err) {
          log.warn("failed hashing candidate, rejecting", { id: c.id, err: String(err) });
          c.rejected = true;
          c.rejectReason = "download-failed";
          store.upsertCandidate(contentKey, c);
        }
      }
    }
    accepted = accepted.filter((c) => !c.rejected);

    // 2. Pairwise dedup - keep the highest-resolution copy of each duplicate cluster.
    const toReject = new Set<string>();
    for (let i = 0; i < accepted.length; i++) {
      if (toReject.has(accepted[i].id)) continue;
      for (let j = i + 1; j < accepted.length; j++) {
        if (toReject.has(accepted[j].id)) continue;
        const dup = await checkDuplicate(accepted[i], accepted[j]);
        if (dup) {
          const loser = quality(accepted[i]) >= quality(accepted[j]) ? accepted[j] : accepted[i];
          toReject.add(loser.id);
          if (loser.id === accepted[i].id) break; // i just got eliminated, move on
        }
      }
    }
    let removedCount = toReject.size;
    for (const id of toReject) {
      const cand = accepted.find((c) => c.id === id)!;
      store.upsertCandidate(contentKey, { ...cand, rejected: true, rejectReason: "duplicate" });
    }
    accepted = accepted.filter((c) => !toReject.has(c.id));

    // 3. Backfill. In "both" mode each provider maintains its OWN target
    //    count independently - if TVDB lost 2 to dedup, we only go deeper
    //    into TVDB's results to replace them, not TMDB's. In "main-backup"
    //    mode there's a single overall target, and backup is only used
    //    per the configured trigger rule.
    const target = config.backdrop.poolTargetSize;

    if (config.backdrop.mode === "both") {
      // Both providers seed the pool with up to poolTargetSize each
      // (see ensureInitialPool above), so the overall target here is
      // double that. Backfilling after dedup checks the MAIN provider's
      // remaining ranked candidates first, regardless of which
      // provider's candidate was actually removed, and only reaches
      // into the backup provider if main is genuinely exhausted -
      // going deep into either provider's results risks lower-quality
      // images, so we'd rather lean on the trusted main provider before
      // resorting to backup, even to replace a backup-provider loss.
      const totalTarget = config.backdrop.poolTargetSize * 2;
      let needed = Math.max(0, totalTarget - accepted.length);
      if (needed > 0) {
        accepted = await backfill(contentKey, ids, config.backdrop.mainProvider, accepted, needed);
        needed = Math.max(0, totalTarget - accepted.length);
      }
      if (needed > 0) {
        accepted = await backfill(contentKey, ids, config.backdrop.backupProvider, accepted, needed);
      }
    } else {
      let needed = Math.max(0, target - accepted.length);
      if (needed > 0) {
        accepted = await backfill(contentKey, ids, config.backdrop.mainProvider, accepted, needed);
        needed = Math.max(0, target - accepted.length);
      }
      const shouldUseBackup = needed > 0 && accepted.length < config.backdrop.minUniqueBeforeBackup;
      if (shouldUseBackup) {
        accepted = await backfill(contentKey, ids, config.backdrop.backupProvider, accepted, needed);
      }
    }

    store.markRefreshed(contentKey);
    log.info("pool refreshed", {
      contentKey,
      finalSize: accepted.length,
      duplicatesRemoved: removedCount,
    });
  } catch (err) {
    log.error("refreshPool failed", { ids, err: String(err) });
  } finally {
    sweepInFlight.delete(contentKey);
  }
}

/** Pulls up to `needed` new, non-duplicate candidates from a provider into the pool. */
async function backfill(
  contentKey: string,
  ids: ParsedIds,
  providerName: ProviderName,
  currentAccepted: BackdropCandidate[],
  needed: number,
): Promise<BackdropCandidate[]> {
  const raw = await fetchCandidates(providerName, ids);
  const knownIds = new Set(store.getPool(contentKey).map((c) => c.id));
  const untried = raw.filter((c) => !knownIds.has(c.id));

  const accepted = [...currentAccepted];
  for (const candidate of untried) {
    if (needed <= 0) break;
    try {
      const sig = await ensureSignatures(candidate);
      candidate.phash = sig.phash;
      candidate.colorSig = sig.colorSig;
      let isDup = false;
      for (const existing of accepted) {
        if (await checkDuplicate(candidate, existing)) {
          isDup = true;
          break;
        }
      }
      if (isDup) {
        store.upsertCandidate(contentKey, { ...candidate, rejected: true, rejectReason: "duplicate" });
      } else {
        store.upsertCandidate(contentKey, { ...candidate, rejected: false });
        accepted.push(candidate);
        needed--;
      }
    } catch (err) {
      log.warn("backfill candidate failed, rejecting", { id: candidate.id, err: String(err) });
      store.upsertCandidate(contentKey, { ...candidate, rejected: true, rejectReason: "download-failed" });
    }
  }
  return accepted;
}

/**
 * Returns the URL that should be served right now for this title,
 * respecting the TTL rotation, and triggers a background pool
 * build/refresh as needed. Never blocks on the full dedup sweep.
 */
export async function getActiveBackdropUrl(ids: ParsedIds): Promise<string | null> {
  const contentKey = buildContentKey(ids);
  const pool = await ensureInitialPool(ids);

  // Fire-and-forget background refresh (deliberately not awaited).
  setImmediate(() => {
    refreshPool(ids).catch((err) => log.error("background refreshPool crashed", { err: String(err) }));
  });

  if (pool.length === 0) return null;

  const rotation = store.getRotationState(contentKey);
  const now = Date.now();
  const ttlMs = config.backdrop.ttlSeconds * 1000;

  const currentStillValid =
    rotation &&
    rotation.currentCandidateId &&
    now - rotation.selectedAt < ttlMs &&
    pool.some((c) => c.id === rotation.currentCandidateId);

  if (currentStillValid) {
    return pool.find((c) => c.id === rotation!.currentCandidateId)!.url;
  }

  // Pick a new random candidate, avoiding an immediate repeat if possible.
  const candidates = pool.filter((c) => c.id !== rotation?.currentCandidateId);
  const pickFrom = candidates.length > 0 ? candidates : pool;
  const choice = pickFrom[Math.floor(Math.random() * pickFrom.length)];

  store.setRotationState(contentKey, choice.id, config.backdrop.ttlSeconds);
  return choice.url;
}

/** Called periodically to keep long-lived pools fresh over time. */
export async function sweepStalePools(): Promise<void> {
  const stale = store.getStalePools(config.backdrop.refreshIntervalSeconds * 1000);
  for (const s of stale) {
    await refreshPool({ tmdbId: s.tmdbId, tvdbId: s.tvdbId, type: s.type as any }).catch((err) =>
      log.error("stale sweep failed", { contentKey: s.contentKey, err: String(err) }),
    );
  }
}
