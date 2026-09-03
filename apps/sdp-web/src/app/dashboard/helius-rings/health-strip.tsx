"use client";

import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import {
  RINGS_HEALTH_COMPONENTS,
  type RingsHealth,
  type RingsHealthStatus,
} from "./helius-rings.data";
import type { RingsHealthAlert } from "./helius-rings.utils";

const HEALTH_BADGE: Record<RingsHealthStatus, "success" | "warning" | "danger"> = {
  green: "success",
  amber: "warning",
  red: "danger",
};

/**
 * Compact one-line status strip for the Rings upstreams. Green components
 * render as a dot next to their name; anything else gets a badge with the
 * status word so the reader isn't guessing at colour.
 */
export function HealthStrip({
  health,
  alerts,
}: {
  health: RingsHealth | null;
  alerts: readonly RingsHealthAlert[];
}) {
  const t = useTranslations();

  return (
    <div className="rounded-[var(--sdp-surface-radius)] bg-surface-raised px-4 py-2.5 shadow-sm ring-1 ring-border-default">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        <span className="font-medium text-primary">{t("DashboardHeliusRings.health.title")}</span>
        {RINGS_HEALTH_COMPONENTS.map((component) => {
          const status = health?.[component] ?? "red";
          const label = t(`DashboardHeliusRings.health.component_${component}`);
          return (
            <div key={component} className="flex items-center gap-2">
              {status === "green" ? (
                <>
                  <span aria-hidden="true" className="size-2 rounded-full bg-success" />
                  <span className="text-secondary">{label}</span>
                </>
              ) : (
                <>
                  <span className="text-secondary">{label}</span>
                  <Badge variant={HEALTH_BADGE[status]}>
                    {t(`DashboardHeliusRings.health.status_${status}`)}
                  </Badge>
                </>
              )}
            </div>
          );
        })}
      </div>
      {alerts.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {alerts.map((alert) => (
            <p key={alert.reason} className="text-xs text-secondary">
              {t("DashboardHeliusRings.health.reason", {
                components: alert.components
                  .map((component) => t(`DashboardHeliusRings.health.component_${component}`))
                  .join(", "),
                reason: alert.reason,
              })}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
