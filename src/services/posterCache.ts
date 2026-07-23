import fetch from "node-fetch";
import sharp from "sharp";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { ParsedIds } from "../types";
import { selectPoster } from "./posterSelector";
import { resizePosterForOutput } from "./posterResize";
import { applyInfoBar } from "./posterInfoBar";
import { computeWeightedRating, parseSourceWeights } from "./ratingAggregator";
import { fetchMdblistRatings } from "../providers/mdblist";
import { tmdbProvider } from "../providers/tmdb";
import * as store from "./store";

const log = createLogger("posterCache");

const generationInFlight = new Map<string, Promise<{ imageData: Buffer; contentType: string; sourceReason: string } | null>>();

export function buildPosterContentKey(ids: ParsedIds): string {
  return `${ids.type ?? "x"}|tmdb:${ids.tmdbId ?? ""}|tvdb:${ids.tvdbId ?? ""}`;
}

async function generate(ids: ParsedIds): Promise<{ imageData: Buffer; contentType: string; sourceReason: string } | null> {
  const picked = await selectPoster(ids);
  if (!picked) return null;

  const originalRes = await fetch(picked.url);
  if (!originalRes.ok) throw new Error(`Failed to fetch source poster (${originalRes.status})`);
  const originalBuffer = Buffer.from(await originalRes.arrayBuffer());

  let working = await resizePosterForOutput(originalBuffer);

  if (config.poster.infoBar.enabled) {
    const metaPromise: Promise<{ genres: string[]; year: number | null } | null> = tmdbProvider.getTitleMeta
      ? tmdbProvider.getTitleMeta({ tmdbId: ids.tmdbId, type: ids.type }).catch((err) => {
          log.warn("getTitleMeta failed", { err: String(err) });
          return null;
        })
      : Promise.resolve(null);

    const [meta, ratings] = await Promise.all([
      metaPromise,
      fetchMdblistRatings(ids).catch((err) => {
        log.warn("fetchMdblistRatings failed", { err: String(err) });
        return [];
      }),
    ]);

    const weights = parseSourceWeights(config.ratingSourceWeights);
    const rating = computeWeightedRating(ratings, weights);

    working = await applyInfoBar(working, {
      genre: meta?.genres?.[0] ?? null,
      year: meta?.year ?? null,
      rating,
    });
  }

  const output = await sharp(working).jpeg({ quality: config.poster.outputQuality }).toBuffer();
  return { imageData: output, contentType: "image/jpeg", sourceReason: picked.reason };
}

/** Only one generation runs at a time per title, even if several requests race in. */
async function generateOnce(contentKey: string, ids: ParsedIds) {
  const existing = generationInFlight.get(contentKey);
  if (existing) return existing;

  const promise = generate(ids).finally(() => generationInFlight.delete(contentKey));
  generationInFlight.set(contentKey, promise);
  return promise;
}

/**
 * Returns a ready-to-serve poster for this title, using the server-side
 * cache whenever possible:
 *
 *  - cache hit, fresh:   return immediately, no work done
 *  - cache hit, stale:   return the cached bytes immediately, and kick
 *                        off a background regeneration for next time
 *                        (never blocks the current request)
 *  - cache miss:         generate synchronously (unavoidable - there's
 *                        nothing to serve yet) and cache the result
 *
 * This is what actually fixes "10 minutes to load a catalog": the first
 * time each title is requested it still has to do real work, but every
 * request after that - including every future app launch - is an
 * instant cache read instead of a fresh TMDB/TVDB round trip + download
 * + image-processing pass.
 */
export async function getPoster(ids: ParsedIds): Promise<{ imageData: Buffer; contentType: string; sourceReason: string } | null> {
  const contentKey = buildPosterContentKey(ids);
  const cached = store.getCachedPoster(contentKey);
  const refreshMs = config.poster.cacheRefreshDays * 24 * 60 * 60 * 1000;

  if (cached) {
    const isStale = Date.now() - cached.generatedAt > refreshMs;
    if (isStale) {
      generateOnce(contentKey, ids)
        .then((fresh) => {
          if (fresh) store.setCachedPoster(contentKey, fresh.imageData, fresh.contentType, fresh.sourceReason);
        })
        .catch((err) => log.error("background poster refresh failed", { contentKey, err: String(err) }));
    }
    return { imageData: cached.imageData, contentType: cached.contentType, sourceReason: cached.sourceReason ?? "cache" };
  }

  const fresh = await generateOnce(contentKey, ids);
  if (!fresh) return null;
  store.setCachedPoster(contentKey, fresh.imageData, fresh.contentType, fresh.sourceReason);
  return fresh;
}
