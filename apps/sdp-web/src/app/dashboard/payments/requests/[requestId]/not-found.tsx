"use client";

import Link from "next/link";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { PAYMENT_REQUESTS_HREF } from "@/lib/payments-routes";

/**
 * A request id the API does not know in this project (removed, mistyped, or another project's):
 * the record's place, saying so, with the way back to the list.
 */
export default function PaymentRequestNotFound() {
  const t = useTranslations();
  return (
    <DashboardWorkspaceOverviewPanel>
      <div className="flex flex-col items-start gap-1" data-payment-request-not-found>
        <p className="text-subheading font-medium text-primary">
          {t("DashboardPayments.requestDetail.notFoundTitle")}
        </p>
        <p className="max-w-md text-nav text-secondary">
          {t("DashboardPayments.requestDetail.notFoundDescription")}
        </p>
        <Button asChild size="sm" className="mt-1.5">
          <Link href={PAYMENT_REQUESTS_HREF}>
            {t("DashboardPayments.requestDetail.backToRequests")}
          </Link>
        </Button>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
