import { readFile } from "node:fs/promises";
import path from "node:path";
import { expandDocsBlocks } from "@/lib/docs-blocks";
import { renderDocsIndexMarkdown } from "@/lib/docs-index-markdown";
import { source } from "@/lib/source";

export const runtime = "nodejs";

function stripMdxShell(source: string): string {
  // Remove frontmatter
  let content = source.replace(/^---\n[\s\S]*?\n---\n?/, "");
  // Remove import lines
  content = content.replace(/^import\s+[^\n]*\n?/gm, "");
  // Collapse excessive blank lines
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

function isSafeSlugSegment(segment: string): boolean {
  return segment.length > 0 && segment !== ".." && segment !== "." && !/[/\\]/.test(segment);
}

function markdownResponse(body: string, pageUrl: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      Vary: "Accept",
      Link: `<${pageUrl}>; rel="canonical", <${pageUrl}.md>; rel="alternate"; type="text/markdown"`,
    },
  });
}

/** The home renders `DocsHome`, so it has no MDX body to serve; its Markdown is the nav. */
function homeMarkdown(): Response {
  const home = source.getPage([]);
  if (!home) {
    return new Response("Not Found", { status: 404 });
  }
  const descriptions = new Map(source.getPages().map((page) => [page.url, page.data.description]));
  const body = renderDocsIndexMarkdown(home.data, source.pageTree, (url) => descriptions.get(url));
  return markdownResponse(body, "/docs");
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;

  // No segments is the docs home: `/docs.md`, or `/docs` asking for Markdown.
  if (slug === undefined) {
    return homeMarkdown();
  }

  if (!slug.every(isSafeSlugSegment)) {
    return new Response("Not Found", { status: 404 });
  }

  // A page outside the deployment's release channel is not in `source`.
  if (!source.getPage(slug) && !source.getPage([...slug, "index"])) {
    return new Response("Not Found", { status: 404 });
  }

  const contentDir = path.resolve(process.cwd(), "content/docs");
  const contentDirPrefix = contentDir + path.sep;

  const candidates = [
    path.resolve(contentDir, `${path.join(...slug)}.mdx`),
    path.resolve(contentDir, ...slug, "index.mdx"),
  ];

  for (const filePath of candidates) {
    if (!filePath.startsWith(contentDirPrefix)) continue;
    try {
      const raw = await readFile(filePath, "utf8");
      const body = stripMdxShell(expandDocsBlocks(raw, filePath));
      return markdownResponse(body, `/docs/${slug.join("/")}`);
    } catch {}
  }

  return new Response("Not Found", { status: 404 });
}
