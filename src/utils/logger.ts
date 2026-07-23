import { config } from "../config";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

function shouldLog(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(config.logLevel as Level);
}

function fmt(level: Level, scope: string, msg: string, extra?: unknown) {
  const time = new Date().toISOString();
  const base = `${time} [${level.toUpperCase()}] (${scope}) ${msg}`;
  return extra !== undefined ? `${base} ${JSON.stringify(extra)}` : base;
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => shouldLog("debug") && console.debug(fmt("debug", scope, msg, extra)),
    info: (msg: string, extra?: unknown) => shouldLog("info") && console.log(fmt("info", scope, msg, extra)),
    warn: (msg: string, extra?: unknown) => shouldLog("warn") && console.warn(fmt("warn", scope, msg, extra)),
    error: (msg: string, extra?: unknown) => shouldLog("error") && console.error(fmt("error", scope, msg, extra)),
  };
}
