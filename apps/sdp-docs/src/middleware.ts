import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

type AcceptEntry = { type: string; q: number };

function parseAccept(accept: string): AcceptEntry[] {
  return accept
    .split(",")
    .map((part) => {
      const [typeRaw, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? parseFloat(qParam.trim().slice(2)) : 1;
      return { type: typeRaw.trim(), q: Number.isNaN(q) ? 1 : q };
    })
    .sort((a, b) => b.q - a.q);
}

// True only when text/markdown is explicitly named and its q >= best HTML q.
// A bare */* from a browser does not count as an explicit markdown preference.
function prefersMarkdown(parts: AcceptEntry[]): boolean {
  const mdEntry = parts.find((p) => p.type === "text/markdown");
  if (!mdEntry || mdEntry.q === 0) return false;

  const htmlQ = Math.max(
    parts.find((p) => p.type === "text/html")?.q ?? 0,
    parts.find((p) => p.type === "*/*")?.q ?? 0
  );

  return mdEntry.q >= htmlQ;
}

// 406 when the Accept header is present and we can serve neither HTML nor Markdown.
function isAcceptable(parts: AcceptEntry[]): boolean {
  return parts.some(
    (p) => p.q > 0 && (p.type === "text/html" || p.type === "text/markdown" || p.type === "*/*")
  );
}

function mergeVary(res: NextResponse, value: string): void {
  const existing = res.headers.get("Vary");
  if (!existing) {
    res.headers.set("Vary", value);
    return;
  }
  const tokens = new Set(
    existing
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
      .map((token) => token.toLowerCase())
  );
  if (tokens.has(value.toLowerCase()) || tokens.has("*")) return;
  res.headers.set("Vary", `${existing}, ${value}`);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Only handle docs content pages — skip assets, API routes, explicit extensions
  if (!pathname.startsWith("/docs/") || pathname.match(/\.[a-z]{2,5}$/i)) {
    return NextResponse.next();
  }

  // Bypass for Next.js RSC / prefetch requests — they negotiate via `text/x-component`
  // and would otherwise fall through to the 406 branch below.
  if (req.headers.get("rsc") || req.headers.get("next-router-prefetch")) {
    return NextResponse.next();
  }

  const accept = req.headers.get("accept") || "";
  const parts = accept ? parseAccept(accept) : [];

  // 406 — client named types we can't serve; skip for requests with no Accept header
  if (accept && !isAcceptable(parts)) {
    return new Response("Not Acceptable", {
      status: 406,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Content negotiation: rewrite to markdown API route
  if (prefersMarkdown(parts)) {
    const slug = pathname.replace(/^\/docs\//, "");
    return NextResponse.rewrite(new URL(`/api/docs-md/${slug}`, req.url));
  }

  // HTML response: add Vary and Link alternate headers
  const res = NextResponse.next();
  mergeVary(res, "Accept");
  res.headers.set("Link", `<${pathname}.md>; rel="alternate"; type="text/markdown"`);
  return res;
}

export const config = {
  matcher: ["/docs/:path*"],
};
