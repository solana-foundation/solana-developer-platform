import { readFile } from "node:fs/promises";
import path from "node:path";

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

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;

  if (!slug.every(isSafeSlugSegment)) {
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
      const body = stripMdxShell(raw);
      const pageUrl = `/docs/${slug.join("/")}`;
      const mdUrl = `${pageUrl}.md`;

      return new Response(body, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          Vary: "Accept",
          Link: `<${pageUrl}>; rel="canonical", <${mdUrl}>; rel="alternate"; type="text/markdown"`,
        },
      });
    } catch {}
  }

  return new Response("Not Found", { status: 404 });
}
