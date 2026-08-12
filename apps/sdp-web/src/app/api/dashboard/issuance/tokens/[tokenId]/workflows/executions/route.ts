import { proxyIssuance } from "@/lib/issuance-proxy";

// GET execution log (optionally ?workflowId=).
export async function GET(request: Request, { params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  const query = new URL(request.url).searchParams.toString();
  return proxyIssuance(
    request,
    `/tokens/${encodeURIComponent(tokenId)}/workflows/executions${query ? `?${query}` : ""}`
  );
}
