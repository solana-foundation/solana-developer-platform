import type { StructuredData } from "fumadocs-core/mdx-plugins";
import { createFromSource } from "fumadocs-core/search/server";
import { z } from "zod";
import { breadcrumbsFor } from "@/lib/breadcrumbs";
import { rankTitlesFirst } from "@/lib/search-rank";
import { source } from "@/lib/source";

type DocsPage = ReturnType<typeof source.getPages>[number];

/**
 * Text this many pages repeat word for word (a shared header's description, the response
 * envelope's fields) matches every query that names it on every operation page, burying the
 * page about it, so the index leaves it out.
 */
const REPEATED_ON_PAGES = 12;

/** Results the dialog shows: pages and their passages. */
const RESULT_LIMIT = 60;

/** The dialog's query: a missing or blank one finds nothing, as Fumadocs' own route answers. */
const searchQuerySchema = z.string().trim().min(1).max(200);

/** A page's searchable text, read as Fumadocs' default index reads it. */
async function structuredDataOf(page: DocsPage): Promise<StructuredData> {
  const data = page.data.structuredData;
  if (data === undefined) throw new Error(`${page.url} has no search text`);
  return typeof data === "function" ? data() : data;
}

function titleOf(page: DocsPage): string {
  if (page.data.title === undefined) throw new Error(`${page.url} has no title`);
  return page.data.title;
}

/** How many pages hold each passage, counted once for the index. */
const pagesWithPassage = (async () => {
  const pages = await Promise.all(source.getPages().map(structuredDataOf));
  const counts = new Map<string, number>();
  for (const { contents } of pages) {
    for (const content of new Set(contents.map((entry) => entry.content))) {
      const pagesSoFar = counts.get(content);
      counts.set(content, pagesSoFar === undefined ? 1 : pagesSoFar + 1);
    }
  }
  return counts;
})();

/** Whether a passage repeats on enough pages to leave the index. Every passage was counted. */
function isRepeated(counts: Map<string, number>, content: string): boolean {
  const pages = counts.get(content);
  if (pages === undefined) throw new Error(`Search passage was never counted: ${content}`);
  return pages >= REPEATED_ON_PAGES;
}

const descriptions = new Map(source.getPages().map((page) => [page.url, page.data.description]));

/**
 * Results the ranking reads: every matching page with its passages (the engine lists at most 8
 * per page), since the engine's top results can miss the page titled with the query.
 */
const CANDIDATE_LIMIT = descriptions.size * 9;

const server = createFromSource(source, {
  // Each result names its section (`API Reference › Wallets`), as the page's breadcrumb does.
  async buildIndex(page) {
    const [structuredData, counts] = await Promise.all([structuredDataOf(page), pagesWithPassage]);
    return {
      id: page.url,
      url: page.url,
      title: titleOf(page),
      description: page.data.description,
      breadcrumbs: breadcrumbsFor(page).map((item) => item.name),
      structuredData: {
        headings: structuredData.headings,
        contents: [
          ...structuredData.contents.filter((entry) => !isRepeated(counts, entry.content)),
          // Canonical URLs make operation names and direct page links searchable too.
          { heading: undefined, content: page.url },
        ],
      },
    };
  },
});

export async function GET(request: Request): Promise<Response> {
  const query = searchQuerySchema.safeParse(new URL(request.url).searchParams.get("query"));
  if (!query.success) return Response.json([]);
  const results = await server.search(query.data, { limit: CANDIDATE_LIMIT });
  const ranked = rankTitlesFirst(results, query.data, (url) => descriptions.get(url));
  return Response.json(ranked.slice(0, RESULT_LIMIT));
}
