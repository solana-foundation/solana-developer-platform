"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";

const NOTICE_TOAST_ID = "payments-demo-notice";

/**
 * Demo mode's disclaimer, a toast in the app's stack that stays until closed. Turning demo mode
 * off or leaving Payments takes it away; turning demo mode on again or reloading brings it back.
 */
export function PaymentsDemoNotice() {
  const t = useTranslations();
  const title = t("DashboardPayments.demo.notice.state");
  const body = t("DashboardPayments.demo.notice.body");
  useEffect(() => {
    toast.info(title, {
      id: NOTICE_TOAST_ID,
      description: body,
      duration: Number.POSITIVE_INFINITY,
    });
    return () => {
      toast.dismiss(NOTICE_TOAST_ID);
    };
  }, [title, body]);
  return null;
}
