import { config } from "../config";
import { providers } from "../providers";
import { createLogger } from "../utils/logger";
import { ParsedIds, ProviderImage, RankedPoster } from "../types";

const log = createLogger("posterSelector");

/**
 * Picks the "best" poster out of a same-language candidate list using a
 * Wilson score lower bound (Evan Miller's "How Not To Sort By Average
 * Rating" - the standard fix for exactly this problem, used by
 * Reddit/HN-style ranking).
 *
 * A plain shrinkage-toward-a-prior approach (what this used to do) only
 * pulls the *point estimate* toward an average - it doesn't account for
 * how *uncertain* that estimate is. In practice this means a poster with
 * one or two lucky high votes can still out-rank a poster with dozens of
 * votes at a slightly lower average, because shrinkage alone never fully
 * neutralizes a big enough raw gap. The Wilson lower bound instead asks
 * "what's the worst this rating is likely to really be, given how much
 * data backs it up?" - a 6-vote 8.0 has a wide, low confidence interval;
 * a 37-vote 5.8 has a narrow one - so the well-tested-but-more-modest
 * poster properly outranks the sparse-but-lucky one.
 *
 * TMDB's 0-10 scale is treated as a proportion (rating/10) for the
 * Wilson formula, then scaled back to 0-10 for comparison/tie-breaking.
 */
function wilsonLowerBound(voteAverage: number, voteCount: number, z: number): number {
  const phat = Math.max(0, Math.min(1, voteAverage / 10));
  const n = voteCount;
  const z2 = z * z;
  const term1 = phat + z2 / (2 * n);
  const term2 = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const denom = 1 + z2 / n;
  return ((term1 - term2) / denom) * 10;
}

function rankByVotes(images: ProviderImage[]): ProviderImage | null {
  if (images.length === 0) return null;
  if (images.length === 1) return images[0];

  const withVotes = images.filter((i) => (i.voteCount ?? 0) > 0 && typeof i.voteAverage === "number");
  if (withVotes.length === 0) {
    // Nobody has any vote data at all - trust the provider's own order.
    return [...images].sort((a, b) => a.sourceIndex - b.sourceIndex)[0];
  }

  const z = config.poster.confidenceZ;
  const scored = withVotes.map((img) => ({
    img,
    score: wilsonLowerBound(img.voteAverage!, img.voteCount!, z),
  }));

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const contenders = scored.filter((s) => Math.abs(s.score - top.score) <= config.voteAverageTieThreshold);
  if (contenders.length === 1) return top.img;

  // Tie-break by raw vote_count: more actual data wins a near-tie.
  return [...contenders].sort((a, b) => (b.img.voteCount ?? 0) - (a.img.voteCount ?? 0))[0].img;
}

export async function selectPoster(ids: ParsedIds): Promise<RankedPoster | null> {
  const main = providers[config.poster.mainProvider];
  const backup = providers[config.poster.backupProvider];
  const lang = config.primaryLanguage;

  const query = { tmdbId: ids.tmdbId, tvdbId: ids.tvdbId, type: ids.type };

  // 1. Main provider, primary language
  const mainLangPosters = await main.getPosters({ ...query, language: lang });
  const mainPick = rankByVotes(mainLangPosters);
  if (mainPick) {
    return { ...mainPick, reason: `${main.name}:${lang}` };
  }
  log.debug("no posters from main provider in primary language, trying backup", { lang, ids });

  // 2. Backup provider, primary language - take backup's first result as-is
  const backupLangPosters = await backup.getPosters({ ...query, language: lang });
  if (backupLangPosters.length > 0) {
    const first = [...backupLangPosters].sort((a, b) => a.sourceIndex - b.sourceIndex)[0];
    return { ...first, reason: `${backup.name}:${lang}` };
  }
  log.debug("no posters from backup provider in primary language, trying original language", { ids });

  // 3. Main provider, original language of the title
  const originalLang = await main.getOriginalLanguage(query);
  if (originalLang && originalLang !== lang) {
    const mainOgPosters = await main.getPosters({ ...query, language: originalLang });
    const ogPick = rankByVotes(mainOgPosters);
    if (ogPick) {
      return { ...ogPick, reason: `${main.name}:original(${originalLang})` };
    }
  }
  log.debug("no posters from main provider in original language, trying backup original language", { ids });

  // 4. Backup provider, original language
  const backupOriginalLang = originalLang ?? (await backup.getOriginalLanguage(query));
  if (backupOriginalLang) {
    const backupOgPosters = await backup.getPosters({ ...query, language: backupOriginalLang });
    if (backupOgPosters.length > 0) {
      const first = [...backupOgPosters].sort((a, b) => a.sourceIndex - b.sourceIndex)[0];
      return { ...first, reason: `${backup.name}:original(${backupOriginalLang})` };
    }
  }

  log.warn("no poster found from any provider/language combination", { ids });
  return null;
}
