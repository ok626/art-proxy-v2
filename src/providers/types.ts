import { MediaType, ProviderImage } from "../types";

export interface ImageQuery {
  tmdbId?: string;
  tvdbId?: string;
  type?: MediaType;
  /** ISO 639-1 language to filter for. Use null for textless/no-language. */
  language: string | null;
  limit?: number;
}

export interface ArtworkProvider {
  name: "tmdb" | "tvdb";
  getPosters(query: ImageQuery): Promise<ProviderImage[]>;
  getBackdrops(query: ImageQuery): Promise<ProviderImage[]>;
  /** Original/primary language TMDB or TVDB has on file for the title, e.g. "ja". */
  getOriginalLanguage(query: Pick<ImageQuery, "tmdbId" | "tvdbId" | "type">): Promise<string | null>;
  /** Genre + release year, for the poster info bar. Only TMDB implements this currently. */
  getTitleMeta?(query: Pick<ImageQuery, "tmdbId" | "tvdbId" | "type">): Promise<{ genres: string[]; year: number | null } | null>;
}
