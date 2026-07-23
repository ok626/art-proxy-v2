import fetch from "node-fetch";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { ProviderImage } from "../types";
import { ArtworkProvider, ImageQuery } from "./types";

const log = createLogger("tmdb");
const API_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p/original";

function endpointFor(type: "movie" | "series" | undefined): string {
  // TMDB calls the "series" media type "tv"
  return type === "series" ? "tv" : "movie";
}

async function tmdbGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("api_key", config.tmdbApiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`TMDB request failed (${res.status}) for ${path}: ${await res.text()}`);
  }
  return res.json();
}

function mapImages(
  arr: any[],
  kind: "poster" | "backdrop",
): ProviderImage[] {
  // Don't trust TMDB's raw response order - it's not documented/guaranteed
  // to be quality-sorted. Explicitly sort by vote_average (desc, missing
  // treated as 0) so "take the first result" downstream actually means
  // "take the best-rated one", consistently.
  const sorted = [...(arr || [])].sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
  return sorted.map((img, idx) => ({
    provider: "tmdb" as const,
    url: `${IMAGE_BASE}${img.file_path}`,
    width: img.width,
    height: img.height,
    language: img.iso_639_1 ?? null,
    voteAverage: img.vote_average,
    voteCount: img.vote_count,
    sourceIndex: idx,
  }));
}

export const tmdbProvider: ArtworkProvider = {
  name: "tmdb",

  async getPosters(query: ImageQuery): Promise<ProviderImage[]> {
    if (!config.tmdbApiKey) return [];
    if (!query.tmdbId) return [];
    const endpoint = endpointFor(query.type);
    const langParam = query.language ? `${query.language},null` : "null";
    try {
      const data = await tmdbGet(`/${endpoint}/${query.tmdbId}/images`, {
        include_image_language: langParam,
      });
      const posters = mapImages(data.posters, "poster");
      // Filter strictly to the requested language (include_image_language is
      // a broadening filter server-side, not an exact match).
      return query.language
        ? posters.filter((p) => p.language === query.language)
        : posters.filter((p) => p.language === null);
    } catch (err) {
      log.warn("getPosters failed", { err: String(err) });
      return [];
    }
  },

  async getBackdrops(query: ImageQuery): Promise<ProviderImage[]> {
    if (!config.tmdbApiKey) return [];
    if (!query.tmdbId) return [];
    const endpoint = endpointFor(query.type);
    try {
      // Textless backdrops = iso_639_1 is null. We always ask for "null"
      // plus the requested language just in case, but filter to textless
      // only afterwards, per the spec (backdrops should be textless).
      const data = await tmdbGet(`/${endpoint}/${query.tmdbId}/images`, {
        include_image_language: "null",
      });
      const backdrops = mapImages(data.backdrops, "backdrop").filter((b) => b.language === null);
      // mapImages already sorted these by vote_average desc, so "first N"
      // means "best-rated N", not whatever order the API happened to return.
      return backdrops.slice(0, query.limit ?? backdrops.length);
    } catch (err) {
      log.warn("getBackdrops failed", { err: String(err) });
      return [];
    }
  },

  async getOriginalLanguage(query): Promise<string | null> {
    if (!config.tmdbApiKey || !query.tmdbId) return null;
    const endpoint = endpointFor(query.type);
    try {
      const data = await tmdbGet(`/${endpoint}/${query.tmdbId}`, {});
      return data.original_language ?? null;
    } catch (err) {
      log.warn("getOriginalLanguage failed", { err: String(err) });
      return null;
    }
  },

  async getTitleMeta(query): Promise<{ genres: string[]; year: number | null } | null> {
    if (!config.tmdbApiKey || !query.tmdbId) return null;
    const endpoint = endpointFor(query.type);
    try {
      const data = await tmdbGet(`/${endpoint}/${query.tmdbId}`, {});
      const genres = Array.isArray(data.genres) ? data.genres.map((g: any) => g.name).filter(Boolean) : [];
      const dateStr = data.release_date || data.first_air_date || null;
      const year = dateStr ? Number(String(dateStr).slice(0, 4)) || null : null;
      return { genres, year };
    } catch (err) {
      log.warn("getTitleMeta failed", { err: String(err) });
      return null;
    }
  },
};
