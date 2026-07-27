import { proxyIssuance } from "@/lib/issuance-proxy";

// POST safe manual retry of a failed / awaiting-review execution.
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
