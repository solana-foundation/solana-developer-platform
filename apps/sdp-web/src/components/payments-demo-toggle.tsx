"use client";

import { XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { PAYMENTS_DEMO_COOKIE_NAME } from "@/lib/payments-demo/demo-cookie";

const DEMO_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
// Project ids are URL-safe; anything else is not written into a cookie.
const COOKIE_SAFE_VALUE = /^[\w-]+$/;

function subscribeToNothing() {
  return () => {};
}

function readDemoProjectId(): string | null {
  const entry = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${PAYMENTS_DEMO_COOKIE_NAME}=`));
  return entry ? entry.slice(PAYMENTS_DEMO_COOKIE_NAME.length + 1) : null;
}

/**
 * The Payments header's demo switch. Off, it offers demo data on a sandbox project; on, it names
 * the state and turns it off (shown on any project, so a demo can never get stuck). Switching
 * reloads the page, so no cached real or demo data outlives the change.
 */
export function PaymentsDemoToggle() {
  const t = useTranslations();
  const { selectedProjectId, sdpEnvironment } = useDashboardWorkspace();
  const demoProjectId = useSyncExternalStore(subscribeToNothing, readDemoProjectId, () => null);
  if (!selectedProjectId || !COOKIE_SAFE_VALUE.test(selectedProjectId)) {
    return null;
  }
  const on = demoProjectId === selectedProjectId;
  if (!on && sdpEnvironment !== "sandbox") {
    return null;
  }

  const toggle = () => {
    // biome-ignore lint/suspicious/noDocumentCookie: The server reads the demo choice on the next request.
    document.cookie = on
      ? `${PAYMENTS_DEMO_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; Secure`
      : `${PAYMENTS_DEMO_COOKIE_NAME}=${selectedProjectId}; Path=/; Max-Age=${DEMO_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
    window.location.reload();
  };

  if (on) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={t("DashboardPayments.demo.turnOff")}
        title={t("DashboardPayments.demo.turnOff")}
        className="inline-flex h-8 items-center gap-1.5 rounded-full bg-info-bg px-3 text-meta font-medium whitespace-nowrap text-info transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-border-strong focus-visible:outline-none"
      >
        {t("DashboardPayments.demo.on")}
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={toggle}
      title={t("DashboardPayments.demo.turnOn")}
    >
      {t("DashboardPayments.demo.label")}
    </Button>
  );
}
