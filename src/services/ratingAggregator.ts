export interface SourceRating {
  source: string;
  /** 0-100 normalized score, as provided by MDBList. */
  score: number;
}

export interface SourceWeight {
  source: string;
  weight: number;
}

/**
 * Parses a "source:weight,source:weight" config string into weight
 * entries, e.g. "letterboxd:70,imdb:20,trakt:10".
 */
export function parseSourceWeights(config: string): SourceWeight[] {
  return config
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [source, weightStr] = part.split(":").map((s) => s.trim());
      return { source: source.toLowerCase(), weight: Number(weightStr) };
    })
    .filter((w) => w.source && Number.isFinite(w.weight) && w.weight > 0);
}

/**
 * Computes a single weighted-average rating (0-100) from whichever
 * sources are actually available, renormalizing the configured weights
 * to the ones present - exactly the "99% Letterboxd, 1% Trakt becomes
 * 100% Trakt if Letterboxd is missing" behavior that was asked for.
 *
 * Returns null if none of the configured sources have data (rather than
 * silently returning some default), so the caller can decide whether to
 * hide the rating entirely for that title.
 */
export function computeWeightedRating(available: SourceRating[], weights: SourceWeight[]): number | null {
  if (weights.length === 0 || available.length === 0) return null;

  const availableBySource = new Map(available.map((r) => [r.source.toLowerCase(), r.score]));
  const matched = weights
    .map((w) => ({ weight: w.weight, score: availableBySource.get(w.source) }))
    .filter((m): m is { weight: number; score: number } => typeof m.score === "number");

  if (matched.length === 0) return null;

  const totalWeight = matched.reduce((sum, m) => sum + m.weight, 0);
  if (totalWeight <= 0) return null;

  const weightedSum = matched.reduce((sum, m) => sum + m.score * (m.weight / totalWeight), 0);
  return weightedSum;
}
