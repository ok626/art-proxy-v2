import dotenv from "dotenv";
import path from "path";

dotenv.config();

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

type Provider = "tmdb" | "tvdb";

export const config = {
  port: num("PORT", 7777),
  publicUrl: str("PUBLIC_URL", "http://localhost:7777"),
  dataDir: str("DATA_DIR", path.join(process.cwd(), "data")),
  logLevel: str("LOG_LEVEL", "info"),
  // Exposes GET /debug/backdrop/... and /debug/poster/... showing full
  // pool state, rejection reasons, and cache metadata. On by default
  // since this runs on your own server, but set to false if you're
  // exposing this app beyond your own network and don't want that
  // introspection public.
  debugEndpointsEnabled: bool("DEBUG_ENDPOINTS_ENABLED", true),

  tmdbApiKey: str("TMDB_API_KEY", ""),
  tvdbApiKey: str("TVDB_API_KEY", ""),
  tvdbPin: str("TVDB_PIN", ""),
  // Free key from MDBList Preferences (mdblist.com) - powers the info
  // bar's aggregated rating by pulling per-source scores (IMDb, TMDb,
  // Trakt, Letterboxd, Metacritic, Rotten Tomatoes, etc.), each already
  // normalized 0-100 by MDBList itself so they're directly comparable.
  mdblistApiKey: str("MDBLIST_API_KEY", ""),
  // How much weight each rating source gets when they're combined into
  // the single aggregated rating shown in the info bar. Format:
  // "source:weight,source:weight,...". If a source is missing for a
  // given title, its weight is dropped and the remaining weights are
  // renormalized proportionally (e.g. "letterboxd:99,trakt:1" becomes
  // 100% trakt if letterboxd has no data for that title) - configured
  // weights are relative to each other, not required to sum to 100.
  // Valid source names (as returned by MDBList): imdb, tmdb, trakt,
  // letterboxd, metacritic, tomatoes (Rotten Tomatoes critics), popcorn
  // (RT audience), mal (MyAnimeList).
  ratingSourceWeights: str("RATING_SOURCE_WEIGHTS", "imdb:50,tmdb:30,trakt:20"),

  primaryLanguage: str("PRIMARY_LANGUAGE", "en"),
  voteAverageTieThreshold: num("VOTE_AVERAGE_TIE_THRESHOLD", 0.3),

  poster: {
    mainProvider: str("POSTER_MAIN_PROVIDER", "tmdb") as Provider,
    backupProvider: str("POSTER_BACKUP_PROVIDER", "tvdb") as Provider,
    outputQuality: num("POSTER_OUTPUT_QUALITY", 90),
    cacheSeconds: num("POSTER_CACHE_SECONDS", 604800),
    // How conservative the Wilson lower-bound ranking is: 1.96 = standard
    // 95% confidence bound (the common default for this kind of ranking).
    // Higher = more skeptical of low vote counts.
    confidenceZ: num("POSTER_CONFIDENCE_Z", 1.96),
    // Target output dimensions - posters are resized to this before any
    // styling is applied, both so file size/generation time stay small
    // and so the result matches what Stremio-like clients actually
    // expect (Stremio's own recommended poster aspect ratio is ~0.675,
    // and 580x859 is close to a natural "retina" size for a ~290px tile).
    outputWidth: num("POSTER_OUTPUT_WIDTH", 580),
    outputHeight: num("POSTER_OUTPUT_HEIGHT", 859),
    // Server-side cache lifetime for the *generated* poster (separate
    // from POSTER_CACHE_SECONDS, which is the client-facing header).
    // After this many days, a cached poster is served instantly while a
    // fresh one regenerates in the background.
    cacheRefreshDays: num("POSTER_CACHE_REFRESH_DAYS", 30),

    infoBar: {
      enabled: bool("POSTER_INFO_BAR_ENABLED", true),
      showGenre: bool("POSTER_INFO_BAR_SHOW_GENRE", true),
      showRating: bool("POSTER_INFO_BAR_SHOW_RATING", true),
      showYear: bool("POSTER_INFO_BAR_SHOW_YEAR", false),
      // Fraction of the poster's height the bar takes up - measured
      // directly from a reference app's screenshot (54px bar on a
      // 750px-tall poster = 0.072), not guessed.
      heightFraction: num("POSTER_INFO_BAR_HEIGHT_FRACTION", 0.072),
      // Bar background opacity, 0-1.
      opacity: num("POSTER_INFO_BAR_OPACITY", 0.72),
      backgroundColor: str("POSTER_INFO_BAR_BACKGROUND_COLOR", "#101014"),
      textColor: str("POSTER_INFO_BAR_TEXT_COLOR", "#ffffff"),
      // "100" shows the MDBList-style 0-100 aggregated score (e.g. "70");
      // "10" shows it rescaled to a familiar 0-10-with-one-decimal look
      // (e.g. "7.0").
      ratingScale: str("POSTER_INFO_BAR_RATING_SCALE", "100") as "10" | "100",
      // A thin fill-proportional-to-rating strip directly above the bar,
      // like a slim progress/health bar (rating/100 filled).
      showProgressBar: bool("POSTER_INFO_BAR_SHOW_PROGRESS_BAR", true),
      progressBarHeightFraction: num("POSTER_INFO_BAR_PROGRESS_BAR_HEIGHT_FRACTION", 0.0055),
      progressTrackColor: str("POSTER_INFO_BAR_PROGRESS_TRACK_COLOR", "rgba(255,255,255,0.22)"),
      progressFillColor: str("POSTER_INFO_BAR_PROGRESS_FILL_COLOR", "#ffffff"),
    },
  },

  backdrop: {
    mainProvider: str("BACKDROP_MAIN_PROVIDER", "tmdb") as Provider,
    backupProvider: str("BACKDROP_BACKUP_PROVIDER", "tvdb") as Provider,
    mode: str("BACKDROP_MODE", "main-backup") as "main-backup" | "both",
    minUniqueBeforeBackup: num("BACKDROP_MIN_UNIQUE_BEFORE_BACKUP", 3),
    poolTargetSize: num("BACKDROP_POOL_TARGET_SIZE", 6),
    fetchLimit: num("BACKDROP_FETCH_LIMIT", 20),
    ttlSeconds: num("BACKDROP_TTL_SECONDS", 300),
    minRelativeWidth: num("BACKDROP_MIN_RELATIVE_WIDTH", 0.4),
    minAbsoluteWidth: num("BACKDROP_MIN_ABSOLUTE_WIDTH", 1280),
    dedupHammingThreshold: num("BACKDROP_DEDUP_HAMMING_THRESHOLD", 8),
    dedupColorSigMaxDistance: num("BACKDROP_DEDUP_COLOR_SIG_MAX_DISTANCE", 0.12),
    refreshIntervalSeconds: num("BACKDROP_REFRESH_INTERVAL_SECONDS", 21600),
  },
};

export type AppConfig = typeof config;
