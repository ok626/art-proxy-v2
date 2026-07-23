import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { BackdropCandidate } from "../types";

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, "artwork.db"));
db.pragma("journal_mode = WAL");

/**
 * Adds a column to an already-existing table if it's missing.
 * `CREATE TABLE IF NOT EXISTS` only applies the schema on a table's first
 * creation - if the table already exists from a previous version of the
 * app (e.g. an upgraded deployment with a persisted /data volume), new
 * columns added in later versions need to be migrated in explicitly, or
 * inserts referencing them fail with "no such column".
 */
function ensureColumn(table: string, column: string, definition: string) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS backdrop_pool (
    content_key TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    url TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    phash TEXT,
    source_index INTEGER,
    vote_average REAL,
    vote_count INTEGER,
    rejected INTEGER DEFAULT 0,
    reject_reason TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (content_key, candidate_id)
  );

  CREATE TABLE IF NOT EXISTS rotation_state (
    content_key TEXT PRIMARY KEY,
    current_candidate_id TEXT,
    selected_at INTEGER,
    ttl_seconds INTEGER
  );

  -- Global memory of which candidate-id pairs are already known duplicates,
  -- so the background dedup sweep never has to re-diff the same pair twice,
  -- even across different titles' pools sharing artwork (rare but possible)
  -- or across repeated refresh cycles for the same title.
  CREATE TABLE IF NOT EXISTS known_duplicate_pairs (
    id_a TEXT NOT NULL,
    id_b TEXT NOT NULL,
    is_duplicate INTEGER NOT NULL,
    PRIMARY KEY (id_a, id_b)
  );

  -- Cache of computed phashes (+ a secondary spatial color signature) by
  -- candidate id (== hash of the URL), so a backdrop that reappears in a
  -- fresh API response never needs re-hashing.
  CREATE TABLE IF NOT EXISTS phash_cache (
    candidate_id TEXT PRIMARY KEY,
    phash TEXT NOT NULL,
    computed_at INTEGER NOT NULL
  );

  -- Remembers which title a content_key maps to (so the periodic background
  -- refresh sweep can re-derive the provider query without waiting for a
  -- new incoming request first).
  CREATE TABLE IF NOT EXISTS content_meta (
    content_key TEXT PRIMARY KEY,
    tmdb_id TEXT,
    tvdb_id TEXT,
    media_type TEXT,
    last_refreshed_at INTEGER
  );

  -- Fully-generated poster bytes (already styled with the info bar), keyed by content.
  -- This is the fix for "regenerating from scratch on every request" -
  -- without it, every catalog load re-runs the full provider lookup +
  -- download + image-processing pipeline for every single title, every
  -- single time, which is the main thing that made poster loading slow.
  CREATE TABLE IF NOT EXISTS poster_cache (
    content_key TEXT PRIMARY KEY,
    image_data BLOB NOT NULL,
    content_type TEXT NOT NULL,
    source_reason TEXT,
    generated_at INTEGER NOT NULL
  );
`);

// Columns added after the initial release - migrated in explicitly so
// upgrading an existing deployment (with a persisted /data volume) never
// breaks on "no such column".
ensureColumn("phash_cache", "color_sig", "TEXT");
ensureColumn("backdrop_pool", "vote_average", "REAL");
ensureColumn("backdrop_pool", "vote_count", "INTEGER");

export function upsertContentMeta(contentKey: string, tmdbId?: string, tvdbId?: string, type?: string) {
  db.prepare(
    `INSERT INTO content_meta (content_key, tmdb_id, tvdb_id, media_type, last_refreshed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(content_key) DO UPDATE SET tmdb_id=excluded.tmdb_id, tvdb_id=excluded.tvdb_id, media_type=excluded.media_type`,
  ).run(contentKey, tmdbId ?? null, tvdbId ?? null, type ?? null, Date.now());
}

export function markRefreshed(contentKey: string) {
  db.prepare(`UPDATE content_meta SET last_refreshed_at = ? WHERE content_key = ?`).run(Date.now(), contentKey);
}

export function getStalePools(olderThanMs: number): { contentKey: string; tmdbId?: string; tvdbId?: string; type?: string }[] {
  const cutoff = Date.now() - olderThanMs;
  const rows = db
    .prepare(`SELECT * FROM content_meta WHERE last_refreshed_at < ?`)
    .all(cutoff) as any[];
  return rows.map((r) => ({
    contentKey: r.content_key,
    tmdbId: r.tmdb_id ?? undefined,
    tvdbId: r.tvdb_id ?? undefined,
    type: r.media_type ?? undefined,
  }));
}

export function getPool(contentKey: string): BackdropCandidate[] {
  const rows = db
    .prepare(`SELECT * FROM backdrop_pool WHERE content_key = ? ORDER BY source_index ASC`)
    .all(contentKey) as any[];
  return rows.map((r) => ({
    id: r.candidate_id,
    provider: r.provider,
    url: r.url,
    width: r.width,
    height: r.height,
    language: null,
    phash: r.phash ?? undefined,
    sourceIndex: r.source_index,
    voteAverage: r.vote_average ?? undefined,
    voteCount: r.vote_count ?? undefined,
    rejected: !!r.rejected,
    rejectReason: r.reject_reason ?? undefined,
  }));
}

export function upsertCandidate(contentKey: string, c: BackdropCandidate) {
  db.prepare(
    `INSERT INTO backdrop_pool (content_key, candidate_id, provider, url, width, height, phash, source_index, vote_average, vote_count, rejected, reject_reason, updated_at)
     VALUES (@contentKey, @id, @provider, @url, @width, @height, @phash, @sourceIndex, @voteAverage, @voteCount, @rejected, @rejectReason, @updatedAt)
     ON CONFLICT(content_key, candidate_id) DO UPDATE SET
       url=excluded.url, width=excluded.width, height=excluded.height,
       phash=excluded.phash, source_index=excluded.source_index,
       vote_average=excluded.vote_average, vote_count=excluded.vote_count,
       rejected=excluded.rejected, reject_reason=excluded.reject_reason, updated_at=excluded.updated_at`,
  ).run({
    contentKey,
    id: c.id,
    provider: c.provider,
    url: c.url,
    width: c.width,
    height: c.height,
    phash: c.phash ?? null,
    sourceIndex: c.sourceIndex,
    voteAverage: c.voteAverage ?? null,
    voteCount: c.voteCount ?? null,
    rejected: c.rejected ? 1 : 0,
    rejectReason: c.rejectReason ?? null,
    updatedAt: Date.now(),
  });
}

export function removeCandidate(contentKey: string, candidateId: string) {
  db.prepare(`DELETE FROM backdrop_pool WHERE content_key = ? AND candidate_id = ?`).run(contentKey, candidateId);
}

export function getRotationState(contentKey: string): { currentCandidateId: string | null; selectedAt: number; ttlSeconds: number } | null {
  const row = db.prepare(`SELECT * FROM rotation_state WHERE content_key = ?`).get(contentKey) as any;
  if (!row) return null;
  return { currentCandidateId: row.current_candidate_id, selectedAt: row.selected_at, ttlSeconds: row.ttl_seconds };
}

export function setRotationState(contentKey: string, currentCandidateId: string, ttlSeconds: number) {
  db.prepare(
    `INSERT INTO rotation_state (content_key, current_candidate_id, selected_at, ttl_seconds)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(content_key) DO UPDATE SET current_candidate_id=excluded.current_candidate_id,
       selected_at=excluded.selected_at, ttl_seconds=excluded.ttl_seconds`,
  ).run(contentKey, currentCandidateId, Date.now(), ttlSeconds);
}

export function getCachedPhash(candidateId: string): { phash: string; colorSig: number[] | null } | null {
  const row = db.prepare(`SELECT phash, color_sig FROM phash_cache WHERE candidate_id = ?`).get(candidateId) as any;
  if (!row) return null;
  return { phash: row.phash, colorSig: row.color_sig ? JSON.parse(row.color_sig) : null };
}

export function setCachedPhash(candidateId: string, phash: string, colorSig: number[]) {
  db.prepare(
    `INSERT INTO phash_cache (candidate_id, phash, color_sig, computed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(candidate_id) DO UPDATE SET phash=excluded.phash, color_sig=excluded.color_sig, computed_at=excluded.computed_at`,
  ).run(candidateId, phash, JSON.stringify(colorSig), Date.now());
}

function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function getKnownDuplicateResult(a: string, b: string): boolean | null {
  const [idA, idB] = pairKey(a, b);
  const row = db.prepare(`SELECT is_duplicate FROM known_duplicate_pairs WHERE id_a = ? AND id_b = ?`).get(idA, idB) as any;
  if (!row) return null;
  return !!row.is_duplicate;
}

export function setKnownDuplicateResult(a: string, b: string, isDuplicate: boolean) {
  const [idA, idB] = pairKey(a, b);
  db.prepare(
    `INSERT INTO known_duplicate_pairs (id_a, id_b, is_duplicate) VALUES (?, ?, ?)
     ON CONFLICT(id_a, id_b) DO UPDATE SET is_duplicate=excluded.is_duplicate`,
  ).run(idA, idB, isDuplicate ? 1 : 0);
}

export interface CachedPoster {
  imageData: Buffer;
  contentType: string;
  sourceReason: string | null;
  generatedAt: number;
}

export function getCachedPoster(contentKey: string): CachedPoster | null {
  const row = db.prepare(`SELECT * FROM poster_cache WHERE content_key = ?`).get(contentKey) as any;
  if (!row) return null;
  return {
    imageData: row.image_data,
    contentType: row.content_type,
    sourceReason: row.source_reason,
    generatedAt: row.generated_at,
  };
}

export function setCachedPoster(contentKey: string, imageData: Buffer, contentType: string, sourceReason: string) {
  db.prepare(
    `INSERT INTO poster_cache (content_key, image_data, content_type, source_reason, generated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(content_key) DO UPDATE SET image_data=excluded.image_data, content_type=excluded.content_type,
       source_reason=excluded.source_reason, generated_at=excluded.generated_at`,
  ).run(contentKey, imageData, contentType, sourceReason, Date.now());
}

export { db };
