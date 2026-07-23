import fetch from "node-fetch";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { ProviderImage } from "../types";
import { ArtworkProvider, ImageQuery } from "./types";

const log = createLogger("tvdb");
const API_BASE = "https://api4.thetvdb.com/v4";

let cachedToken: { token: string; expiresAt: number } | null = null;
// TVDB artwork "type" ids are dynamic per-install (fetched from /artwork/types)
// and differ between movies and series, so we resolve+cache them by slug
// instead of hardcoding ids that can drift between TVDB installs.
let artworkTypeCache: { id: number; slug: string; recordType: string }[] | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const body: Record<string, string> = { apikey: config.tvdbApiKey };
  if (config.tvdbPin) body.pin = config.tvdbPin;

  const res = await fetch(`${API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TVDB login failed (${res.status}): ${await res.text()}`);
  const json: any = await res.json();
  const token = json.data.token as string;
  // TVDB tokens are valid ~1 month; refresh well before that to be safe.
  cachedToken = { token, expiresAt: Date.now() + 20 * 60 * 60 * 1000 };
  return token;
}

async function tvdbGet(path: string): Promise<any> {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`TVDB request failed (${res.status}) for ${path}: ${await res.text()}`);
  return res.json();
}

async function getArtworkTypes(): Promise<{ id: number; slug: string; recordType: string }[]> {
  if (artworkTypeCache) return artworkTypeCache;
  const data = await tvdbGet("/artwork/types");
  artworkTypeCache = (data.data || []).map((t: any) => ({
    id: t.id,
    slug: t.slug,
    recordType: t.recordType,
  }));
  return artworkTypeCache!;
}

async function typeIdFor(slug: "poster" | "background", recordType: "movie" | "series"): Promise<number | null> {
  const types = await getArtworkTypes();
  const match = types.find((t) => t.slug === slug && t.recordType === recordType);
  return match ? match.id : null;
}

function recordTypeFor(type: "movie" | "series" | undefined): "movie" | "series" {
  return type === "series" ? "series" : "movie";
}

async function fetchArtworks(query: ImageQuery): Promise<any[]> {
  if (!query.tvdbId) return [];
  const recordType = recordTypeFor(query.type);
  const path = recordType === "series" ? `/series/${query.tvdbId}/extended` : `/movies/${query.tvdbId}/extended`;
  // Deliberately NOT using short=true here: TVDB's `short` param returns
  // an abbreviated record with heavier nested fields trimmed down, and
  // the artworks array is exactly the kind of thing that can get cut or
  // truncated under it - which would explain getting some backdrops
  // back, but not the complete set the site's gallery shows.
  const data = await tvdbGet(`${path}?meta=translations`);
  const artworks = data.data?.artworks || [];
  log.debug("fetched raw artworks", { tvdbId: query.tvdbId, recordType, count: artworks.length });
  return artworks;
}

/** Exposed for the /debug/tvdb-artworks diagnostic route - not used in the normal request path. */
export async function debugFetchRawArtworks(tvdbId: string, type: "movie" | "series" | undefined) {
  const artworks = await fetchArtworks({ tvdbId, type, language: null });
  const recordType = recordTypeFor(type);
  const posterType = await typeIdFor("poster", recordType);
  const bgType = await typeIdFor("background", recordType);
  return { totalCount: artworks.length, posterTypeId: posterType, backgroundTypeId: bgType, artworks };
}

function mapArtwork(a: any, idx: number): ProviderImage {
  return {
    provider: "tvdb",
    url: a.image,
    width: a.width ?? 0,
    height: a.height ?? 0,
    // TVDB uses 3-letter-ish/ISO-639-2-ish codes sometimes; normalize to
    // the 2-letter form where possible, otherwise pass through.
    language: a.language ?? null,
    voteAverage: a.score,
    voteCount: undefined,
    sourceIndex: idx,
  };
}

/**
 * TVDB's /extended artworks array is NOT guaranteed to come back in
 * "best first" order (it often looks close to insertion/id order, which
 * doesn't match what thetvdb.com's own gallery shows you, since that's
 * sorted by community score). We replicate that by sorting by `score`
 * descending ourselves before assigning sourceIndex, so "take the first
 * result" downstream means the same thing it does for TMDB.
 */
function sortAndMap(artworks: any[]): ProviderImage[] {
  const sorted = [...artworks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return sorted.map(mapArtwork);
}

export const tvdbProvider: ArtworkProvider = {
  name: "tvdb",

  async getPosters(query: ImageQuery): Promise<ProviderImage[]> {
    if (!config.tvdbApiKey || !query.tvdbId) return [];
    try {
      const recordType = recordTypeFor(query.type);
      const posterType = await typeIdFor("poster", recordType);
      const artworks = await fetchArtworks(query);
      const filtered = artworks
        .filter((a) => (posterType ? a.type === posterType : true))
        .filter((a) => (query.language ? a.language === query.language : true));
      return sortAndMap(filtered);
    } catch (err) {
      log.warn("getPosters failed", { err: String(err) });
      return [];
    }
  },

  async getBackdrops(query: ImageQuery): Promise<ProviderImage[]> {
    if (!config.tvdbApiKey || !query.tvdbId) return [];
    try {
      const recordType = recordTypeFor(query.type);
      const bgType = await typeIdFor("background", recordType);
      const artworks = await fetchArtworks(query);
      const filtered = artworks
        .filter((a) => (bgType ? a.type === bgType : true))
        // "textless" on TVDB == no language tag on the artwork
        .filter((a) => !a.language);
      return sortAndMap(filtered).slice(0, query.limit ?? filtered.length);
    } catch (err) {
      log.warn("getBackdrops failed", { err: String(err) });
      return [];
    }
  },

  async getOriginalLanguage(query): Promise<string | null> {
    if (!config.tvdbApiKey || !query.tvdbId) return null;
    try {
      const recordType = recordTypeFor(query.type);
      const path = recordType === "series" ? `/series/${query.tvdbId}` : `/movies/${query.tvdbId}`;
      const data = await tvdbGet(path);
      return data.data?.originalLanguage ?? null;
    } catch (err) {
      log.warn("getOriginalLanguage failed", { err: String(err) });
      return null;
    }
  },
};
