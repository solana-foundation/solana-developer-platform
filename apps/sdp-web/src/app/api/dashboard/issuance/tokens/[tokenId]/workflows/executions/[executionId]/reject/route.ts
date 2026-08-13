import { proxyIssuance } from "@/lib/issuance-proxy";

// POST reject a held (awaiting_review) execution → cancelled. The action never runs.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ tokenId: string; executionId: string }> }
) {
  const { tokenId, executionId } = await params;
  return proxyIssuance(
    request,
    `/tokens/${encodeURIComponent(tokenId)}/workflows/executions/${encodeURIComponent(executionId)}/reject`,
    { method: "POST" }
  );
}
