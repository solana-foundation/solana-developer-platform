import { proxyIssuance } from "@/lib/issuance-proxy";

// POST re-attempt a failed execution. Approving a held one is a separate route.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ tokenId: string; executionId: string }> }
) {
  const { tokenId, executionId } = await params;
  return proxyIssuance(
    request,
    `/tokens/${encodeURIComponent(tokenId)}/workflows/executions/${encodeURIComponent(executionId)}/retry`,
    { method: "POST" }
  );
}
