import { getTranslations } from "@/i18n/server";
import { dashboardJson } from "@/lib/dashboard-response";

type RouteContext = { params: Promise<{ recurringPaymentId: string }> };

/**
 * The schedule id from the route, decoded: Next hands the segment over still percent-encoded,
 * and the sdp-api path encodes it again. A malformed segment is a 400 answer instead.
 */
export async function readRecurringPaymentId(
  context: RouteContext
): Promise<{ ok: true; recurringPaymentId: string } | { ok: false; response: Response }> {
  const { recurringPaymentId } = await context.params;
  try {
    return { ok: true, recurringPaymentId: decodeURIComponent(recurringPaymentId) };
  } catch {
    const t = await getTranslations();
    return {
      ok: false,
      response: dashboardJson(
        { error: { message: t("DashboardPayments.recurring.invalidId") } },
        { status: 400 }
      ),
    };
  }
}
