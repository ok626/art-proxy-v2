import { ProviderName } from "../types";
import { ArtworkProvider } from "./types";
import { tmdbProvider } from "./tmdb";
import { tvdbProvider } from "./tvdb";

export const providers: Record<ProviderName, ArtworkProvider> = {
  tmdb: tmdbProvider,
  tvdb: tvdbProvider,
};
