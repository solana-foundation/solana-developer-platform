import { PAYMENT_RECURRING_PAYMENT_ACTIONS } from "@sdp/types";
import { NextResponse } from "next/server";
import { z } from "zod";
import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = {
  params: Promise<{ recurringPaymentId: string; action: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { recurringPaymentId, action } = await context.params;
  const parsedAction = z.enum(PAYMENT_RECURRING_PAYMENT_ACTIONS).safeParse(action);
  if (!parsedAction.success) {
    return NextResponse.json(
      { error: { message: "Recurring payment action is not supported" } },
      { status: 404 }
    );
  }

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.action",
    path: `/v1/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}/${parsedAction.data}`,
  });
}
