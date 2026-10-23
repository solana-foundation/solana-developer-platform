import { isAddress } from "@solana/kit";
import { proxyToSdpApi } from "@/lib/sdp-api";

/** A mint's Token Terms (ADR 0012): decimals, transfer fee and display rule. */
export async function GET(request: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!isAddress(mint)) {
    return Response.json({ error: { message: "Invalid token mint" } }, { status: 400 });
  }
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.tokens.terms.get",
    path: `/v1/tokens/${encodeURIComponent(mint)}/terms`,
  });
}
