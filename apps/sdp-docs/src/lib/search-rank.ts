import { API_METHODS } from "@sdp/api-catalog/reference";
import type { SortedResult } from "fumadocs-core/search";

const API_METHOD_NAMES: ReadonlySet<string> = new Set(API_METHODS);

/** A text's words, lowercased: its runs of letters and digits, as the search index splits them. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Prefixes cover inflections in either direction, including "withdraw" and "withdrawal". */
function hasWord(words: string[], queryWord: string): boolean {
  return words.some(
    (word) => word.startsWith(queryWord) || (word.length >= 4 && queryWord.startsWith(word))
  );
}

/** An endpoint's own searchable label, without mistaking a prose mention for its owner. */
function matchesEndpoint(content: string, query: string): boolean {
  const [method, path, ...rest] = content.split(/\s+/);
  if (path === undefined || rest.length > 0 || !API_METHOD_NAMES.has(method)) return false;
  return content.toLowerCase() === query || path.toLowerCase() === query;
}

/** Direct page URLs, operation names, endpoint labels, and full titles beat loose mentions. */
function exactRank(
  page: SortedResult,
  passages: SortedResult[],
  query: string
): number | undefined {
  const queryWords = wordsOf(query).join(" ");
  const slugWords = wordsOf(page.url.replace(/^.*\//, "")).join(" ");
  if (
    query === page.url.toLowerCase() ||
    (queryWords.length > 0 && queryWords === slugWords) ||
    passages.some((passage) => matchesEndpoint(passage.content, query))
  ) {
    return -2;
  }
  return queryWords.length > 0 && queryWords === wordsOf(page.content).join(" ") ? -1 : undefined;
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
 * guides precede reference pages of the same rank. Exact URLs, operation names, and endpoint
 * labels come first; matching headings precede passing mentions. Otherwise the engine's order
 * stays, and each page keeps its matching passages.
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
  const groups: {
    rank: number;
    reference: boolean;
    results: [SortedResult, ...SortedResult[]];
  }[] = [];
  for (const result of results) {
    if (result.type === "page") {
      const rank = rankOf(
        queryWords,
        wordsOf(result.content),
        wordsOf(descriptionOf(result.url) ?? "")
      );
      groups.push({
        rank,
        reference:
          result.url === "/docs/reference/api" || result.url.startsWith("/docs/reference/api/"),
        results: [result],
      });
    } else {
      // The engine lists each page before its passages.
      const page = groups.at(-1);
      if (page === undefined) throw new Error(`Search passage came before its page: ${result.url}`);
      page.results.push(result);
    }
  }
  for (const group of groups) {
    const [page, ...passages] = group.results;
    const exact = exactRank(page, passages, query.trim().toLowerCase());
    if (exact !== undefined) group.rank = exact;
    else if (
      passages.some(
        (passage) =>
          passage.type === "heading" &&
          queryWords.every((word) => hasWord(wordsOf(passage.content), word))
      )
    ) {
      group.rank = Math.min(group.rank, 1);
    }
  }
  return groups
    .sort((a, b) => a.rank - b.rank || Number(a.reference) - Number(b.reference))
    .flatMap((group) => group.results);
}
