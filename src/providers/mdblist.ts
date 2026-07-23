import fetch from "node-fetch";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { MediaType } from "../types";
import { SourceRating } from "../services/ratingAggregator";

const log = createLogger("mdblist");
const API_BASE = "https://api.mdblist.com";

/**
 * Fetches the raw per-source ratings array for a title from MDBList.
 * Prefers looking up by TMDB id (most reliable, matches what this app
 * already has on hand); falls back to TVDB id for shows if that's all
 * that's available. Returns an empty array (not an error) if MDBList
 * isn't configured or the title isn't found, so callers can treat
 * "no rating data" as a normal, expected case.
 */
export async function fetchMdblistRatings(ids: { tmdbId?: string; tvdbId?: string; type?: MediaType }): Promise<SourceRating[]> {
  if (!config.mdblistApiKey) return [];

  const mediatype = ids.type === "series" ? "show" : "movie";
  let provider: string;
  let id: string;
  if (ids.tmdbId) {
    provider = "tmdb";
    id = ids.tmdbId;
  } else if (ids.tvdbId && mediatype === "show") {
    provider = "tvdb";
    id = ids.tvdbId;
  } else {
    return [];
  }

  try {
    const url = `${API_BASE}/${provider}/${mediatype}/${id}?apikey=${config.mdblistApiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      log.warn("mdblist request failed", { status: res.status, provider, mediatype, id });
      return [];
    }
    const data: any = await res.json();
    const ratings = Array.isArray(data.ratings) ? data.ratings : [];
    return ratings
      .filter((r: any) => typeof r.score === "number" && r.score !== null)
      .map((r: any) => ({ source: String(r.source).toLowerCase(), score: r.score }));
  } catch (err) {
    log.warn("mdblist fetch failed", { err: String(err) });
    return [];
  }
}
