import { NextResponse } from "next/server";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RecurringPaymentAction = "activate" | "collect" | "cancel" | "resume";
type RouteContext = {
  params: Promise<{ recurringPaymentId: string; action: string }>;
};

const ACTIONS = new Set<RecurringPaymentAction>(["activate", "collect", "cancel", "resume"]);

function isRecurringPaymentAction(action: string): action is RecurringPaymentAction {
  return ACTIONS.has(action as RecurringPaymentAction);
}

export async function POST(request: Request, context: RouteContext) {
  const { recurringPaymentId, action } = await context.params;
  if (!isRecurringPaymentAction(action)) {
    return NextResponse.json(
      { error: { message: "Recurring payment action is not supported" } },
      { status: 404 }
    );
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.action",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}/${action}`,
  });
}
