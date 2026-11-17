import path from "node:path";
import { docsPageSlugOf, isDocsFolderGroup } from "@/lib/site";

/** Earn discovery links appear only when their pages pass publication gates. */
export const EARN_KEY_PAGE_SLUGS = [
  "earn/index",
  "earn/quickstart",
  "earn/treasury-quickstart",
  "earn/concepts",
  "guides/embedded-yield",
  "earn/treasury",
] as const;

/** Navigation metadata, with paths relative to its containing folder. */
export type DocsMeta = {
  readonly title?: string;
  readonly pages?: readonly string[];
};

/** A page already admitted by the build's publication gates. */
export type DocsPage = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly content: string;
  /** Shared pages have no module or provider gate. */
  readonly shared: boolean;
};

/** An ordered group of pages in the full AI corpus. */
export type DocsSection = {
  title: string;
  pages: DocsPage[];
};

/**
 * Orders published pages by navigation, then includes unlisted pages once.
 * The pages map is the publication boundary; metadata never admits a page.
 */
export function buildSections(
  meta: DocsMeta,
  pages: ReadonlyMap<string, DocsPage>,
  folderMetas: ReadonlyMap<string, DocsMeta>,
  excludedSlugs: ReadonlySet<string> = new Set()
): DocsSection[] {
  const sections: DocsSection[] = [];
  const emitted = new Set<string>();
  let currentSection: DocsSection = { title: "Docs", pages: [] };

  const flush = () => {
    if (currentSection.pages.length > 0) sections.push(currentSection);
  };

  const visit = (entry: string, slugPrefix: string, parentLabel: string | null): void => {
    if (entry.startsWith("---") && entry.endsWith("---")) {
      flush();
      const label = entry.replace(/---/g, "").trim();
      currentSection = { title: parentLabel ? `${parentLabel}: ${label}` : label, pages: [] };
      return;
    }

    // Fumadocs accepts ../ links between folders, including the Earn guide.
    const fullSlug = path.posix.normalize(path.posix.join(slugPrefix, entry));
    const pageSlug = docsPageSlugOf(fullSlug);
    const page = pages.get(pageSlug);
    if (page) {
      if (!emitted.has(pageSlug)) {
        currentSection.pages.push(page);
        emitted.add(pageSlug);
      }
      return;
    }
    if (excludedSlugs.has(pageSlug)) return;

    const folderMeta = folderMetas.get(fullSlug);
    if (!folderMeta) {
      console.warn(`generate-ai-resources: no page or folder for entry "${fullSlug}": skipping`);
      return;
    }

    flush();
    const group = isDocsFolderGroup(path.posix.basename(fullSlug));
    const sectionTitle =
      group && parentLabel
        ? `${parentLabel}: ${folderMeta.title || entry}`
        : folderMeta.title || entry;
    currentSection = { title: sectionTitle, pages: [] };
    const folderIndex = group ? undefined : pages.get(docsPageSlugOf(`${fullSlug}/index`));
    if (
      folderIndex &&
      !(folderMeta.pages ?? []).includes("index") &&
      !emitted.has(folderIndex.slug)
    ) {
      currentSection.pages.push(folderIndex);
      emitted.add(folderIndex.slug);
    }
    for (const subEntry of folderMeta.pages ?? []) visit(subEntry, fullSlug, sectionTitle);
    flush();
    currentSection = { title: "Docs", pages: [] };
  };

  visit("introduction", "", null);
  for (const entry of meta.pages ?? []) visit(entry, "", null);

  const rootFolders = [...folderMetas.keys()].filter((folder) => !folder.includes("/"));
  const navRoots = (meta.pages ?? []).map((entry) => entry.split("/")[0]).filter(Boolean);
  for (const folder of new Set([...navRoots, ...rootFolders])) {
    if (folderMetas.has(folder)) visit(folder, "", null);
  }
  flush();

  // Navigation can omit individual pages or folders without a meta.json.
  const unlisted = [...pages.values()]
    .filter((page) => !emitted.has(page.slug))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  if (unlisted.length > 0) sections.push({ title: "Docs", pages: unlisted });
  return sections;
}

/**
 * Selects required discovery links and any published optional guides.
 * @throws When a required page is absent from the publication-filtered map.
 */
export function selectKeyPages(
  pages: ReadonlyMap<string, DocsPage>,
  requiredSlugs: readonly string[],
  optionalSlugs: readonly string[]
): DocsPage[] {
  const slugs = new Set([...requiredSlugs, ...optionalSlugs.filter((slug) => pages.has(slug))]);
  return [...slugs].map((slug) => {
    const page = pages.get(slug);
    if (!page) throw new Error(`Missing required key docs page "${slug}" for llms.txt generation`);
    return page;
  });
}
