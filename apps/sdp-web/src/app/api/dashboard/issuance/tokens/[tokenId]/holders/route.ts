import { proxyIssuance } from "@/lib/issuance-proxy";

// GET enrolled holders · POST enroll a wallet (v1 clearance act).
export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  const query = new URL(request.url).searchParams.toString();
  return proxyIssuance(
    request,
    `/tokens/${encodeURIComponent(tokenId)}/holders${query ? `?${query}` : ""}`
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  const body = await request.json().catch(() => ({}));
  return proxyIssuance(request, `/tokens/${encodeURIComponent(tokenId)}/holders`, {
    method: "POST",
    body,
  });
}
