import { app } from "./server";
import { config } from "./config";
import { createLogger } from "./utils/logger";
import { sweepStalePools } from "./services/backdropPool";

const log = createLogger("bootstrap");

app.listen(config.port, () => {
  log.info(`stremio-artwork listening on port ${config.port}`, { publicUrl: config.publicUrl });
});

// Periodically keep long-lived title pools fresh (picks up newly uploaded
// artwork over time). Runs every refresh interval, checking for pools
// older than that same interval.
const sweepMs = Math.max(config.backdrop.refreshIntervalSeconds, 3600) * 1000;
setInterval(() => {
  sweepStalePools().catch((err) => log.error("sweepStalePools crashed", { err: String(err) }));
}, sweepMs);
