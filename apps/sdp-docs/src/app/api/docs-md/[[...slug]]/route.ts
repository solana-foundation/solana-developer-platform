import { readFile } from "node:fs/promises";
import path from "node:path";
import { expandDocsBlocks, stripMdxEsm } from "@/lib/docs-blocks";
import { renderDocsIndexMarkdown } from "@/lib/docs-index-markdown";
import { aiLlmsUrl, aiSkillUrl, getDocsMarkdownUrl } from "@/lib/site";
import { source } from "@/lib/source";

export const runtime = "nodejs";

// Opens every page's Markdown, so an agent that lands on one page can find the rest.
const AGENT_CONTEXT = `> Solana Developer Platform docs, served as Markdown. The [docs index](${getDocsMarkdownUrl("")}) lists every page and [llms.txt](${aiLlmsUrl}) the key ones; [SKILL.md](${aiSkillUrl}) has the rules for building on SDP.`;

function stripMdxShell(source: string, where: string): string {
  // Remove frontmatter
  let content = source.replace(/^---\n[\s\S]*?\n---\n?/, "");
  content = stripMdxEsm(content, where);
  // Collapse excessive blank lines
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

function isSafeSlugSegment(segment: string): boolean {
  return segment.length > 0 && segment !== ".." && segment !== "." && !/[/\\]/.test(segment);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A page's frontmatter title and description lead its body, as the page renders them. */
function pageMarkdown(data: { title?: string; description?: string }, body: string): string {
  const lead = [
    data.title && `# ${singleLine(data.title)}`,
    data.description && singleLine(data.description),
  ];
  return [...lead, body].filter(Boolean).join("\n\n");
}

function markdownResponse(body: string, pageUrl: string): Response {
  return new Response(`${AGENT_CONTEXT}\n\n${body.trim()}\n`, {
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
  const page = source.getPage(slug) ?? source.getPage([...slug, "index"]);
  if (!page) {
    return new Response("Not Found", { status: 404 });
  }

  // The page's own file, which a `(group)` folder keeps apart from its slug.
  const contentDir = path.resolve(process.cwd(), "content/docs");
  const filePath = path.resolve(contentDir, page.path);
  if (!filePath.startsWith(contentDir + path.sep)) {
    return new Response("Not Found", { status: 404 });
  }

  const raw = await readFile(filePath, "utf8");
  const body = stripMdxShell(expandDocsBlocks(raw, filePath), filePath);
  return markdownResponse(pageMarkdown(page.data, body), `/docs/${slug.join("/")}`);
}
