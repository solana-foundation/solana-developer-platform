"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";

const NOTICE_TOAST_ID = "payments-demo-notice";
const NOTICE_DURATION_MS = 6000;

/**
 * Demo mode's disclaimer, a toast in the app's stack. It shows on entering demo mode and clears
 * itself after a few seconds, so it doesn't cover the content it sits over; closing it, turning
 * demo mode off or leaving Payments also takes it away. Turning demo mode on again or reloading
 * brings it back.
 */
export function PaymentsDemoNotice() {
  const t = useTranslations();
  const title = t("DashboardPayments.demo.notice.state");
  const body = t("DashboardPayments.demo.notice.body");
  useEffect(() => {
    toast.info(title, {
      id: NOTICE_TOAST_ID,
      description: body,
      duration: NOTICE_DURATION_MS,
    });
    return () => {
      toast.dismiss(NOTICE_TOAST_ID);
    };
  }, [title, body]);
  return null;
}
