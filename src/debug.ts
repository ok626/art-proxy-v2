import express, { Request, Response } from "express";
import { config } from "./config";
import { parseIdString } from "./utils/parseIds";
import { buildContentKey } from "./services/backdropPool";
import { buildPosterContentKey } from "./services/posterCache";
import { debugFetchRawArtworks } from "./providers/tvdb";
import { fetchMdblistRatings } from "./providers/mdblist";
import { tmdbProvider } from "./providers/tmdb";
import { computeWeightedRating, parseSourceWeights } from "./services/ratingAggregator";
import * as store from "./services/store";

export const debugRouter = express.Router();

// GET /debug/rating/tvdb:81189&tmdb:series:1396.jpg
// Shows the RAW per-source ratings MDBList returned, the configured
// weights (parsed), and the final computed aggregate - so you can
// verify your MDBLIST_API_KEY and RATING_SOURCE_WEIGHTS are doing what
// you expect without needing to generate a full poster to see it.
debugRouter.get("/rating/:idstring", async (req: Request, res: Response) => {
  const ids = parseIdString(req.params.idstring);
  if (!ids.tmdbId && !ids.tvdbId) {
    return res.status(400).json({ error: "No tmdb or tvdb id present in request" });
  }

  try {
    const [meta, ratings] = await Promise.all([
      tmdbProvider.getTitleMeta ? tmdbProvider.getTitleMeta({ tmdbId: ids.tmdbId, type: ids.type }) : Promise.resolve(null),
      fetchMdblistRatings(ids),
    ]);
    const weights = parseSourceWeights(config.ratingSourceWeights);
    const aggregate = computeWeightedRating(ratings, weights);

    res.json({
      mdblistConfigured: !!config.mdblistApiKey,
      genre: meta?.genres ?? [],
      year: meta?.year ?? null,
      configuredWeights: weights,
      rawRatingsFromMdblist: ratings,
      computedAggregate: aggregate,
      note:
        ratings.length === 0
          ? config.mdblistApiKey
            ? "MDBList returned no ratings for this title - check the id/type are correct."
            : "MDBLIST_API_KEY is not set."
          : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /debug/tvdb-artworks/81189?type=series
// Hits TVDB directly and returns the RAW artwork list for an id, with no
// filtering/sorting/pooling applied - use this to compare the count and
// content against what thetvdb.com's own gallery shows for the same
// title, to check whether we're getting the complete set from the API.
debugRouter.get("/tvdb-artworks/:tvdbId", async (req: Request, res: Response) => {
  const tvdbId = req.params.tvdbId;
  const type = req.query.type === "series" ? "series" : req.query.type === "movie" ? "movie" : undefined;
  try {
    const result = await debugFetchRawArtworks(tvdbId, type);
    res.json({
      tvdbId,
      type: type ?? "movie (default - pass ?type=series if this is a show)",
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /debug/backdrop/tvdb:81189&tmdb:series:1396.jpg
// Shows the FULL current backdrop pool for a title, including rejected
// candidates and why they were rejected, plus what's currently active.
// This exists so you can see exactly why a given backdrop is or isn't
// in rotation, instead of hand-tracing raw provider JSON.
debugRouter.get("/backdrop/:idstring", (req: Request, res: Response) => {
  const ids = parseIdString(req.params.idstring);
  if (!ids.tmdbId && !ids.tvdbId) {
    return res.status(400).json({ error: "No tmdb or tvdb id present in request" });
  }

  const contentKey = buildContentKey(ids);
  const pool = store.getPool(contentKey);
  const rotation = store.getRotationState(contentKey);

  if (pool.length === 0) {
    return res.json({
      contentKey,
      note: "No pool exists yet for this title - request /backdrop/... for it at least once first.",
    });
  }

  const accepted = pool.filter((c) => !c.rejected).sort((a, b) => a.sourceIndex - b.sourceIndex);
  const rejected = pool.filter((c) => c.rejected);

  res.json({
    contentKey,
    mode: config.backdrop.mode,
    poolTargetSize: config.backdrop.poolTargetSize,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    currentlyActive: rotation
      ? {
          candidateId: rotation.currentCandidateId,
          url: pool.find((c) => c.id === rotation.currentCandidateId)?.url ?? null,
          selectedAt: new Date(rotation.selectedAt).toISOString(),
          ttlSeconds: rotation.ttlSeconds,
          expiresAt: new Date(rotation.selectedAt + rotation.ttlSeconds * 1000).toISOString(),
        }
      : null,
    accepted: accepted.map((c) => ({
      id: c.id,
      provider: c.provider,
      url: c.url,
      width: c.width,
      height: c.height,
      voteAverage: c.voteAverage,
      voteCount: c.voteCount,
      sourceRank: c.sourceIndex,
    })),
    rejected: rejected.map((c) => ({
      id: c.id,
      provider: c.provider,
      url: c.url,
      width: c.width,
      height: c.height,
      voteAverage: c.voteAverage,
      sourceRank: c.sourceIndex,
      reason: c.rejectReason,
    })),
  });
});

// GET /debug/poster/tvdb:81189&tmdb:series:1396.jpg
// Shows what's cached for a poster and why it was picked, without
// triggering a regeneration.
debugRouter.get("/poster/:idstring", (req: Request, res: Response) => {
  const ids = parseIdString(req.params.idstring);
  if (!ids.tmdbId && !ids.tvdbId) {
    return res.status(400).json({ error: "No tmdb or tvdb id present in request" });
  }

  const contentKey = buildPosterContentKey(ids);
  const cached = store.getCachedPoster(contentKey);

  if (!cached) {
    return res.json({ contentKey, note: "No cached poster yet - request /poster/... for it at least once first." });
  }

  res.json({
    contentKey,
    sourceReason: cached.sourceReason,
    generatedAt: new Date(cached.generatedAt).toISOString(),
    sizeBytes: cached.imageData.length,
    contentType: cached.contentType,
  });
});
