import { proxyIssuance } from "@/lib/issuance-proxy";

// POST approve a held (awaiting_review) execution → pending. Distinct from retry: this
// authorizes an action that has never run, and is audited as such.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ tokenId: string; executionId: string }> }
) {
  const { tokenId, executionId } = await params;
  return proxyIssuance(
    request,
    `/tokens/${encodeURIComponent(tokenId)}/workflows/executions/${encodeURIComponent(executionId)}/approve`,
    { method: "POST" }
  );
}
