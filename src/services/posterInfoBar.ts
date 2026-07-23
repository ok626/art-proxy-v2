import sharp from "sharp";
import { config } from "../config";

export interface InfoBarData {
  genre?: string | null;
  /** 0-100 scale, matching what ratingAggregator produces. */
  rating?: number | null;
  year?: number | null;
}

function formatRating(rating: number): string {
  if (config.poster.infoBar.ratingScale === "10") {
    return (rating / 10).toFixed(1);
  }
  return String(Math.round(rating));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Composites a dark, semi-opaque bar across the bottom of the poster
 * showing genre and a single aggregated rating (and optionally year),
 * plus an optional thin rating-progress strip directly above it.
 *
 * Three real bugs fixed here versus the first version, each confirmed
 * by direct measurement rather than assumed:
 *
 *  1. Font: was falling back to DejaVu Sans, which looks noticeably
 *     more "generic Linux" than the clean, modern sans-serif reference
 *     apps use. Switched to Roboto (Android/Material Design's system
 *     font - added to the Dockerfile), which is a much closer match to
 *     what most streaming-app UIs actually use, with a semibold (600,
 *     not 700) weight - the reference text reads as noticeably lighter
 *     than a full bold.
 *
 *  2. Vertical alignment: `dominant-baseline="central"` is not reliably
 *     supported by librsvg. Tested directly - anchoring text at the bar
 *     midpoint with dominant-baseline=central put the actual visual
 *     center of the text 12.5px above where it should be, out of a
 *     100px test canvas. That matches exactly what "misaligned, sitting
 *     too high" looks like. Fixed by dropping dominant-baseline
 *     entirely and using a manually-tuned baseline offset
 *     (centerY + fontSize * 0.4), verified empirically to land within
 *     0.5px of true center.
 *
 *  3. Sizing: bar height and font size were guessed, not measured. Bar
 *     height fraction is now 0.072 and font size is ~0.59x the bar
 *     height, both derived from directly measuring the reference
 *     screenshot's actual pixel proportions (bar height was 54px on a
 *     750px-tall poster; text ink height was 23px within that 54px bar).
 */
export async function applyInfoBar(resizedPoster: Buffer, data: InfoBarData): Promise<Buffer> {
  const W = config.poster.outputWidth;
  const H = config.poster.outputHeight;
  const bar = config.poster.infoBar;

  const parts: string[] = [];
  if (bar.showGenre && data.genre) parts.push(data.genre);
  if (bar.showRating && typeof data.rating === "number") parts.push(`\u2605 ${formatRating(data.rating)}`);
  if (bar.showYear && data.year) parts.push(String(data.year));

  const showProgressBar = bar.showProgressBar && typeof data.rating === "number";

  if (parts.length === 0 && !showProgressBar) {
    // Nothing to show for this title - return the poster untouched
    // rather than drawing an empty bar.
    return resizedPoster;
  }

  const barHeight = Math.round(H * bar.heightFraction);
  const fontSize = Math.round(barHeight * 0.59);
  const textCenterY = H - barHeight / 2;
  const textBaselineY = textCenterY + fontSize * 0.4;

  const progressHeight = Math.max(2, Math.round(H * bar.progressBarHeightFraction));
  const progressY = H - barHeight - progressHeight;
  const fillRatio = typeof data.rating === "number" ? Math.max(0, Math.min(1, data.rating / 100)) : 0;

  const svgParts: string[] = [];

  if (showProgressBar) {
    svgParts.push(
      `<rect x="0" y="${progressY}" width="${W}" height="${progressHeight}" fill="${bar.progressTrackColor}" />`,
      `<rect x="0" y="${progressY}" width="${Math.round(W * fillRatio)}" height="${progressHeight}" fill="${bar.progressFillColor}" />`,
    );
  }

  svgParts.push(`<rect x="0" y="${H - barHeight}" width="${W}" height="${barHeight}" fill="${bar.backgroundColor}" fill-opacity="${bar.opacity}" />`);

  if (parts.length > 0) {
    const text = parts.join("   \u00b7   ");
    svgParts.push(
      `<text x="${W / 2}" y="${textBaselineY}" font-family="Roboto, DejaVu Sans, Arial, sans-serif" font-weight="600" ` +
        `font-size="${fontSize}" fill="${bar.textColor}" text-anchor="middle" letter-spacing="0.3">${escapeXml(text)}</text>`,
    );
  }

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svgParts.join("\n")}</svg>`;

  return sharp(resizedPoster)
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}
