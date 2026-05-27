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

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const contentDir = path.join(process.cwd(), "content/docs");

  const candidates = [
    `${path.join(contentDir, ...slug)}.mdx`,
    path.join(contentDir, ...slug, "index.mdx"),
  ];

  for (const filePath of candidates) {
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
          Link: `<${pageUrl}>; rel="alternate"; type="text/html", <${mdUrl}>; rel="canonical"`,
        },
      });
    } catch {}
  }

  return new Response("Not Found", { status: 404 });
}
