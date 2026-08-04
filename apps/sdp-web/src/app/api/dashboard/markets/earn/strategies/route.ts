import { proxyToSdpApi } from "@/lib/sdp-api";

const SOURCE_KINDS = new Set(["defi", "rwa"]);
const APY_TYPES = new Set(["variable", "fixed"]);
const LIQUIDITY_TERMS = new Set(["instant", "delayed"]);

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const query = new URLSearchParams();
  const sourceKind = incoming.searchParams.get("sourceKind");
  const apyType = incoming.searchParams.get("apyType");
  const liquidityTerm = incoming.searchParams.get("liquidityTerm");
  const page = incoming.searchParams.get("page");
  const pageSize = incoming.searchParams.get("pageSize");

  if (sourceKind && SOURCE_KINDS.has(sourceKind)) query.set("sourceKind", sourceKind);
  if (apyType && APY_TYPES.has(apyType)) query.set("apyType", apyType);
  if (liquidityTerm && LIQUIDITY_TERMS.has(liquidityTerm)) {
    query.set("liquidityTerm", liquidityTerm);
  }
  if (page && /^\d{1,4}$/.test(page)) query.set("page", page);
  if (pageSize && /^\d{1,3}$/.test(pageSize)) query.set("pageSize", pageSize);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.strategies.list",
    path: `/v1/earn/strategies${query.size > 0 ? `?${query}` : ""}`,
  });
}
