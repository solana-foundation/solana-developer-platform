import {
  EARN_APY_TYPES,
  EARN_LIQUIDITY_TERMS,
  EARN_STRATEGY_SOURCE_KINDS,
  SOLANA_CLUSTERS,
} from "@sdp/types";
import { proxyToSdpApi } from "@/lib/sdp-api";

const SOURCE_KINDS = new Set<string>(EARN_STRATEGY_SOURCE_KINDS);
const APY_TYPES = new Set<string>(EARN_APY_TYPES);
const LIQUIDITY_TERMS = new Set<string>(EARN_LIQUIDITY_TERMS);
const CLUSTERS = new Set<string>(SOLANA_CLUSTERS);

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const query = new URLSearchParams();
  const sourceKind = incoming.searchParams.get("sourceKind");
  const apyType = incoming.searchParams.get("apyType");
  const liquidityTerm = incoming.searchParams.get("liquidityTerm");
  const cluster = incoming.searchParams.get("cluster");
  const page = incoming.searchParams.get("page");
  const pageSize = incoming.searchParams.get("pageSize");

  if (sourceKind && SOURCE_KINDS.has(sourceKind)) query.set("sourceKind", sourceKind);
  if (apyType && APY_TYPES.has(apyType)) query.set("apyType", apyType);
  if (liquidityTerm && LIQUIDITY_TERMS.has(liquidityTerm)) {
    query.set("liquidityTerm", liquidityTerm);
  }
  // Cluster opt-in (PRO-1742): omitted, the API lists the environment's own
  // cluster; the sandbox toggle passes the shelf it wants to browse.
  if (cluster && CLUSTERS.has(cluster)) query.set("cluster", cluster);
  if (page && /^\d{1,4}$/.test(page)) query.set("page", page);
  if (pageSize && /^\d{1,3}$/.test(pageSize)) query.set("pageSize", pageSize);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.strategies.list",
    path: `/v1/earn/strategies${query.size > 0 ? `?${query}` : ""}`,
  });
}
