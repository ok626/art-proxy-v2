// sharp-phash has no type definitions, hence the require + any.
// It computes a 64-bit perceptual hash (DCT-based, like the classic
// pHash algorithm) from image bytes using sharp under the hood, and
// returns it as a 64-character binary string ("1010110...").
// eslint-disable-next-line @typescript-eslint/no-var-requires
const phash = require("sharp-phash") as (input: Buffer) => Promise<string>;

export async function computePHash(imageBuffer: Buffer): Promise<string> {
  return phash(imageBuffer);
}

/** Hamming distance between two equal-length binary hash strings (0-64). */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`Hash length mismatch: ${a.length} vs ${b.length}`);
  }
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

/** True if two images are similar enough to be considered duplicates. */
export function isDuplicate(hashA: string, hashB: string, threshold: number): boolean {
  return hammingDistance(hashA, hashB) <= threshold;
}
