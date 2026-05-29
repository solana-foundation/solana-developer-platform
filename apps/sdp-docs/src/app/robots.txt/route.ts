import { docsOrigin } from "@/lib/site";

export const runtime = "nodejs";

export function GET() {
  const host = new URL(docsOrigin).host;
  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
    "",
    `Sitemap: ${docsOrigin}/sitemap.xml`,
    `Host: ${host}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
