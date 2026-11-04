import type { SortedResult } from "fumadocs-core/search";

/** A text's words, lowercased: its runs of letters and digits, as the search index splits them. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Whether a word of `words` starts with `queryWord`, as the index matches a word ("key", "keys"). */
function hasWord(words: string[], queryWord: string): boolean {
  return words.some((word) => word.startsWith(queryWord));
}

/**
 * How much of the query a page's own words hold: every query word in its title (0), in its title
 * and description together (1), some in its title (2), or none (3).
 */
function rankOf(queryWords: string[], titleWords: string[], descriptionWords: string[]): number {
  if (queryWords.every((word) => hasWord(titleWords, word))) return 0;
  const ownWords = [...titleWords, ...descriptionWords];
  if (queryWords.every((word) => hasWord(ownWords, word))) return 1;
  return queryWords.some((word) => hasWord(titleWords, word)) ? 2 : 3;
}

/**
 * Search results with the pages about the query first. The engine ranks a page by its best
 * passage, so a reference page that names a term in passing can outrank the guide titled with
 * it. Pages are ordered by how much of the query their title and description hold (`rankOf`);
 * each keeps the engine's order within its rank, and its passages stay under it.
 *
 * @param results - The engine's results: each page, then its matching passages.
 * @param query - The query.
 * @param descriptionOf - A page's description by its URL.
 * @returns The same results, regrouped.
 */
export function rankTitlesFirst(
  results: SortedResult[],
  query: string,
  descriptionOf: (url: string) => string | undefined
): SortedResult[] {
  const queryWords = wordsOf(query);
  const groups: { rank: number; results: SortedResult[] }[] = [];
  for (const result of results) {
    if (result.type === "page") {
      const rank = rankOf(
        queryWords,
        wordsOf(String(result.content)),
        wordsOf(descriptionOf(result.url) ?? "")
      );
      groups.push({ rank, results: [result] });
    } else {
      groups.at(-1)?.results.push(result);
    }
  }
  return groups.sort((a, b) => a.rank - b.rank).flatMap((group) => group.results);
}
