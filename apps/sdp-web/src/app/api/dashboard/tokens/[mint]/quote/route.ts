import { isAddress } from "@solana/kit";
import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Prices a token amount, or a display amount, under the mint's live terms
 * (ADR 0012). Read-only: it takes no Idempotency-Key.
 */
export async function POST(request: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!isAddress(mint)) {
    return Response.json({ error: { message: "Invalid token mint" } }, { status: 400 });
  }
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.tokens.quote.post",
    path: `/v1/tokens/${encodeURIComponent(mint)}/quote`,
  });
}
