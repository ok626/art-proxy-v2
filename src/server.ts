import express, { Request, Response } from "express";
import { config } from "./config";
import { createLogger } from "./utils/logger";
import { parseIdString } from "./utils/parseIds";
import { getPoster } from "./services/posterCache";
import { getActiveBackdropUrl } from "./services/backdropPool";
import { debugRouter } from "./debug";

const log = createLogger("server");
export const app = express();

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

if (config.debugEndpointsEnabled) {
  app.use("/debug", debugRouter);
}

// ---------------------------------------------------------------------
// POSTER: /poster/tvdb:81189&tmdb:series:1396.jpg
// ---------------------------------------------------------------------
app.get("/poster/:idstring", async (req: Request, res: Response) => {
  try {
    const ids = parseIdString(req.params.idstring);
    if (!ids.tmdbId && !ids.tvdbId) {
      return res.status(400).send("No tmdb or tvdb id present in request");
    }

    const poster = await getPoster(ids);
    if (!poster) {
      return res.status(404).send("No poster found");
    }

    res.set("Content-Type", poster.contentType);
    res.set("Cache-Control", `public, max-age=${config.poster.cacheSeconds}, immutable`);
    res.set("X-Artwork-Source", poster.sourceReason);
    return res.send(poster.imageData);
  } catch (err) {
    log.error("poster route failed", { err: String(err) });
    return res.status(500).send("Internal error generating poster");
  }
});

// ---------------------------------------------------------------------
// BACKDROP: /backdrop/tvdb:81189&tmdb:series:1396.jpg
// ---------------------------------------------------------------------
app.get("/backdrop/:idstring", async (req: Request, res: Response) => {
  try {
    const ids = parseIdString(req.params.idstring);
    if (!ids.tmdbId && !ids.tvdbId) {
      return res.status(400).send("No tmdb or tvdb id present in request");
    }

    const url = await getActiveBackdropUrl(ids);
    if (!url) {
      return res.status(404).send("No backdrop found");
    }

    // Deliberately uncacheable: the *redirect target* is what rotates over
    // time on a fixed request URL, so clients must always come back to us
    // rather than caching a stale redirect/image.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    return res.redirect(302, url);
  } catch (err) {
    log.error("backdrop route failed", { err: String(err) });
    return res.status(500).send("Internal error resolving backdrop");
  }
});
