import { proxyToSdpApi } from "@/lib/sdp-api";
import { programProxyQuery } from "../../../provider-query";

/**
 * The withdrawal LEDGER list (SDP's DB, never the provider). Treasury reads the
 * complete collection after programs load so an accepted in-flight withdrawal
 * resumes canonical provider polling after a reload.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ programId: string }> }
) {
  const { programId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.withdrawals.list",
    path: `/v1/earn/programs/${encodeURIComponent(programId)}/withdrawals${programProxyQuery(request, { page: true })}`,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ programId: string }> }
) {
  const { programId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.withdrawals.create",
    path: `/v1/earn/programs/${encodeURIComponent(programId)}/withdrawals`,
  });
}
