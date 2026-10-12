"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useSWRConfig } from "swr";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { setPaymentsDemoAction } from "@/lib/payments-demo/demo-mode-action";
import {
  isPaymentsDemoOn,
  type PaymentsDemoState,
} from "@/lib/payments-demo/payments-demo-context";
import { cn } from "@/lib/utils";

/**
 * The Payments header's demo mode switch, on every Payments screen. It can be turned on on a
 * sandbox project, and off on any project, so a demo can never get stuck. Switching redraws the
 * page in place, no reload: every cached read is dropped and fetched again, the server parts are
 * drawn again, and the shell remounts the page (see dashboard-shell.tsx), so no real or demo
 * data, and nothing done in the demo, outlives the change.
 */
export function PaymentsDemoToggle(state: PaymentsDemoState) {
  const t = useTranslations();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { selectedProjectId, sdpEnvironment } = useDashboardWorkspace();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<boolean | null>(null);
  const on = isPaymentsDemoOn(state, selectedProjectId);
  // The switch shows where it is going until the page has been drawn in the new mode.
  const checked = pending && target !== null ? target : on;
  const productionOnly = !on && sdpEnvironment === "production";

  const change = (next: boolean) => {
    setTarget(next);
    startTransition(async () => {
      try {
        if (await setPaymentsDemoAction(next, selectedProjectId)) {
          await mutate(() => true, undefined, { revalidate: true });
          router.refresh();
        }
      } catch {
        // The switch goes back to where it was.
      }
    });
  };

  // One control, its label inside the track: the knob sits at the start when off and slides
  // to the end when on, the word taking the space it leaves.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={t(
        productionOnly
          ? "DashboardPayments.demo.sandboxOnly"
          : on
            ? "DashboardPayments.demo.turnOff"
            : "DashboardPayments.demo.turnOn"
      )}
      disabled={pending || productionOnly}
      onClick={() => change(!checked)}
      className={cn(
        "relative inline-flex h-8 w-21 shrink-0 items-center rounded-full text-meta font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-border-strong focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none",
        checked
          ? "bg-info-bg pr-8 pl-3 text-info"
          : "bg-fill-subtle pr-3 pl-8 text-secondary hover:text-primary"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1 left-1 size-6 rounded-full transition-transform motion-reduce:transition-none",
          checked ? "translate-x-13 bg-info" : "translate-x-0 bg-border-strong"
        )}
      />
      <span className="w-full text-center">{t("DashboardPayments.demo.label")}</span>
    </button>
  );
}
