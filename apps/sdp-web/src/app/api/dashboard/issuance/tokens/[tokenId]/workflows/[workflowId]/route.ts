import { proxyIssuance } from "@/lib/issuance-proxy";

// PATCH update rule (enable/disable, edit definition).
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ tokenId: string; workflowId: string }> }
) {
  const { tokenId, workflowId } = await params;
  const body = await request.json().catch(() => ({}));
  return proxyIssuance(
    request,
    `/tokens/${encodeURIComponent(tokenId)}/workflows/${encodeURIComponent(workflowId)}`,
    { method: "PATCH", body }
  );
}

// DELETE remove rule (soft delete server-side; execution history is retained).
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ tokenId: string; workflowId: string }> }
) {
  const { tokenId, workflowId } = await params;
  return proxyIssuance(
    request,
    `/tokens/${encodeURIComponent(tokenId)}/workflows/${encodeURIComponent(workflowId)}`,
    { method: "DELETE" }
  );
}
