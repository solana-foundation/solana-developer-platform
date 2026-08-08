import { proxyIssuance } from "@/lib/issuance-proxy";

// GET triggers + per-asset action support for the builder.
export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  return proxyIssuance(request, `/tokens/${encodeURIComponent(tokenId)}/workflows/catalog`);
}
