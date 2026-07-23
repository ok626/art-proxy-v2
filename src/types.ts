export type MediaType = "movie" | "series";
export type ProviderName = "tmdb" | "tvdb";

export interface ParsedIds {
  tvdbId?: string;
  tmdbId?: string;
  type?: MediaType;
}

export interface ProviderImage {
  provider: ProviderName;
  url: string;
  width: number;
  height: number;
  language: string | null; // null / "xx" == textless
  voteAverage?: number;
  voteCount?: number;
  /** provider's own ordering position in the response, 0-based */
  sourceIndex: number;
}

export interface RankedPoster extends ProviderImage {
  reason: string;
}

export interface BackdropCandidate extends ProviderImage {
  id: string; // stable id derived from url, used as dedup key
  phash?: string;
  colorSig?: number[];
  rejected?: boolean;
  rejectReason?: string;
}
