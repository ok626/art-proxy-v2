import { MediaType, ParsedIds } from "../types";

/**
 * AIOMetadata substitutes its {tvdb_id}/{tmdb_id}/{type} placeholders
 * directly into the URL template you configure, e.g.:
 *
 *   tvdb:81189&tmdb:series:1396.jpg
 *   tmdb:movie:27205.jpg              (no tvdb id known)
 *   tvdb:81189.jpg                    (no tmdb id known)
 *
 * When an id is unknown, AIOMetadata simply omits that whole segment
 * (including its "&" joiner), so we can't rely on fixed positions -
 * we parse whatever "key:value" pairs are present.
 */
export function parseIdString(raw: string): ParsedIds {
  const withoutExt = raw.replace(/\.(jpg|jpeg|png|webp)$/i, "");
  const segments = withoutExt.split("&").map((s) => s.trim()).filter(Boolean);

  const result: ParsedIds = {};

  for (const segment of segments) {
    const parts = segment.split(":");
    if (parts[0] === "tvdb" && parts[1]) {
      result.tvdbId = parts[1];
    } else if (parts[0] === "tmdb") {
      // tmdb:{type}:{id}  OR  tmdb:{id} (type unknown)
      if (parts.length >= 3) {
        const type = parts[1] as MediaType;
        if (type === "movie" || type === "series") result.type = type;
        result.tmdbId = parts[2];
      } else if (parts[1]) {
        result.tmdbId = parts[1];
      }
    }
  }

  return result;
}
