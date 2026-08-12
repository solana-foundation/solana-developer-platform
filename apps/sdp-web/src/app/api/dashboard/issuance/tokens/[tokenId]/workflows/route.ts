import { proxyIssuance } from "@/lib/issuance-proxy";

// GET list rules · POST create rule
export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  return proxyIssuance(request, `/tokens/${encodeURIComponent(tokenId)}/workflows`);
}

export async function POST(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  const body = await request.json().catch(() => ({}));
  return proxyIssuance(request, `/tokens/${encodeURIComponent(tokenId)}/workflows`, {
    method: "POST",
    body,
  });
}
