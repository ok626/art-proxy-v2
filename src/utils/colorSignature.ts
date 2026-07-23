import sharp from "sharp";

/**
 * A tiny (8x8, RGB) spatially-aware color thumbnail, flattened to 192
 * numbers. Unlike a global color histogram (which two compositionally
 * different images can share by coincidence - e.g. "mostly orange sky"),
 * this preserves rough spatial layout, so it corroborates pHash's
 * frequency-domain similarity with a second, differently-biased signal.
 * Cheap: computed from the same already-downloaded image bytes.
 */
export async function computeColorSignature(imageBuffer: Buffer): Promise<number[]> {
  const { data } = await sharp(imageBuffer)
    .resize(8, 8, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return Array.from(data);
}

/** Normalized (0-1) distance between two signatures; 0 = identical. */
export function colorSignatureDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return 1;
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sumSq += d * d;
  }
  const rms = Math.sqrt(sumSq / a.length);
  return rms / 255;
}
