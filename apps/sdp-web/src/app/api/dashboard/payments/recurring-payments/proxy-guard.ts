import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { PROJECT_COOKIE_NAME } from "@/lib/project-cookie";
import type { createTimedTrace } from "@/lib/request-tracing";
import { logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, type SdpApiClient } from "@/lib/sdp-api";

type TimedTrace = ReturnType<typeof createTimedTrace>;

type RecurringPaymentsProxyClientResult =
  | { ok: true; apiClient: SdpApiClient }
  | { ok: false; response: NextResponse };

function guardedResponse(trace: TimedTrace, status: number, message: string) {
  logRouteResult(trace, status, { error: message });
  return NextResponse.json(
    { error: { message } },
    {
      status,
      headers: {
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    }
  );
}

export async function getRecurringPaymentsProxyClient(
  trace: TimedTrace
): Promise<RecurringPaymentsProxyClientResult> {
  const { userId, orgId } = await auth();
  if (!userId) {
    return { ok: false, response: guardedResponse(trace, 401, "Authentication required") };
  }
  if (!orgId) {
    return { ok: false, response: guardedResponse(trace, 403, "Active organization required") };
  }

  const selectedProjectId = (await cookies()).get(PROJECT_COOKIE_NAME)?.value;
  if (!selectedProjectId) {
    return { ok: false, response: guardedResponse(trace, 400, "Selected project required") };
  }

  const apiClient = await createSdpApiClient(
    trace.childContext("route.dashboard.recurring-payments.api")
  );
  return { ok: true, apiClient };
}
