import sharp from "sharp";
import { config } from "../config";

/**
 * Resizes source poster art to the configured output dimensions. Returns
 * PNG (not JPEG) so the info bar step never loses quality to a premature
 * lossy encode - the final JPEG encode happens exactly once, at the end
 * of the pipeline in posterCache.ts.
 */
export async function resizePosterForOutput(originalPoster: Buffer): Promise<Buffer> {
  const W = config.poster.outputWidth;
  const H = config.poster.outputHeight;
  return sharp(originalPoster).resize(W, H, { fit: "cover", position: "attention" }).png().toBuffer();
}
