import { z } from "zod";
import { sectionOverridesOf, topLevelUrlsOf } from "./sidebar-section";
import { source } from "./source";

export type BreadcrumbItem = { name: string; url: string };

export type ResolvedPage = {
  page: NonNullable<ReturnType<typeof source.getPage>>;
  pageSlug: string[];
};

const breadcrumbMetadataSchema = z.object({ breadcrumbParent: z.string().optional() });

/**
 * The page a docs URL's slug names: the page itself, else its folder's index.
 *
 * @param slug - The URL's segments after `/docs`; none for the home.
 * @returns The page and the slug that found it, or null when no page matches.
 */
export function resolvePage(slug?: string[]): ResolvedPage | null {
  if (!slug || slug.length === 0) {
    const rootPage = source.getPage([]);
    return rootPage ? { page: rootPage, pageSlug: [] } : null;
  }

  const directPage = source.getPage(slug);
  if (directPage) {
    return { page: directPage, pageSlug: slug };
  }

  const indexSlug = [...slug, "index"];
  const indexPage = source.getPage(indexSlug);
  if (indexPage) {
    return { page: indexPage, pageSlug: indexSlug };
  }

  return null;
}

/**
 * The section pages above a page, from the sidebar's top level down. A page's parent is its
 * `breadcrumbParent`, else the nearest folder index above its path.
 *
 * @param page - The page.
 * @returns Its trail, empty for a page the sidebar lists at its top level.
 */
export function breadcrumbsFor(page: ResolvedPage["page"]): BreadcrumbItem[] {
  const topLevelUrls = new Set(topLevelUrlsOf(source.pageTree));
  if (topLevelUrls.has(page.url)) return [];

  const items: BreadcrumbItem[] = [];
  const seen = new Set([page.url]);
  let current = page;

  while (!topLevelUrls.has(current.url)) {
    const { breadcrumbParent: override } = breadcrumbMetadataSchema.parse(current.data);
    const segments = current.url
      .replace(/^\/docs\/?/, "")
      .split("/")
      .filter(Boolean);
    const parent = override
      ? resolvePage(
          override
            .replace(/^\/docs\/?/, "")
            .split("/")
            .filter(Boolean)
        )?.page
      : [...segments.keys()]
          .slice(1)
          .reverse()
          .map((length) => resolvePage(segments.slice(0, length))?.page)
          .find((candidate) => candidate && candidate.url !== current.url);

    if (override && !parent) throw new Error(`Unknown breadcrumb parent: ${override}`);
    if (!parent || seen.has(parent.url)) break;
    seen.add(parent.url);
    items.unshift({ name: String(parent.data.title), url: parent.url });
    current = parent;
  }

  return items;
}

/**
 * The sidebar entry each page sits under where its path alone does not say so: its breadcrumb
 * starts at a different top-level page (Create a wallet, under `/docs/guides`, belongs to
 * Wallets). The sidebar finds every other page's entry by its path (`sectionByPath`).
 *
 * @returns Section URLs by page URL.
 */
export function sidebarSectionOverrides(): Record<string, string> {
  const pages = source.getPages().map((page) => {
    const [section] = breadcrumbsFor(page);
    return { url: page.url, section: section?.url };
  });
  return sectionOverridesOf(pages, topLevelUrlsOf(source.pageTree));
}
