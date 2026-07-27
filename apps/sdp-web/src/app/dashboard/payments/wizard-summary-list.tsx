"use client";

import { ChevronLeftIcon, type LucideIcon } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

export interface WizardSummaryDetail {
  /** Lucide icon component, or an image path for logo rows (e.g. providers). */
  icon: LucideIcon | string;
  label: string;
  /** Omitted for rows whose payload is reached through the JSON drill-in. */
  value?: string;
  /** When set, the row offers a View JSON drill-in rendering this payload. */
  json?: Record<string, string>;
}

/**
 * Renders the memo payload as titled, pretty-printed JSON.
 *
 * @param props - The memo record shown in the JSON block.
 * @returns The memo JSON view.
 */
export function MemoJsonView({ json }: { json: Record<string, string> }) {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-base font-medium text-primary">
          {t("DashboardPayments.ramps.memoJsonTitle")}
        </p>
        <p className="text-sm text-tertiary">{t("DashboardPayments.ramps.memoJsonDescription")}</p>
      </div>
      <pre className="max-h-80 overflow-auto rounded-xl border border-border-default bg-surface-sunken p-4 font-mono text-sm text-primary">
        <code>{JSON.stringify(json, null, 2)}</code>
      </pre>
    </div>
  );
}

/**
 * Renders the selections a user has made so far in a payments wizard, with an
 * in-place JSON drill-in for rows that carry a payload.
 *
 * @param props - The labeled selection values, in step order.
 * @returns The wizard summary list.
 */
export function WizardSummaryList({ details }: { details: WizardSummaryDetail[] }) {
  const t = useTranslations();
  const [jsonDetail, setJsonDetail] = useState<WizardSummaryDetail | null>(null);

  if (jsonDetail?.json) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setJsonDetail(null)}
          className="flex items-center gap-1 text-sm font-medium text-tertiary transition-colors hover:text-primary"
        >
          <ChevronLeftIcon className="size-4" />
          {t("DashboardPayments.previous")}
        </button>
        <MemoJsonView json={jsonDetail.json} />
      </div>
    );
  }

  return (
    <div>
      <p className="text-base font-medium text-primary">
        {t("DashboardPayments.wizardSummaryTitle")}
      </p>
      <div className="mt-3">
        {details.map((detail) => (
          <div
            key={detail.label}
            className="flex items-start gap-2.5 border-b border-border-subtle py-2.5 last:border-b-0"
          >
            {typeof detail.icon === "string" ? (
              <Image
                src={detail.icon}
                alt=""
                width={16}
                height={16}
                className="mt-0.5 size-4 shrink-0 rounded-sm object-contain"
              />
            ) : (
              <detail.icon className="mt-0.5 size-4 shrink-0 text-muted" />
            )}
            <span className="shrink-0 text-sm text-tertiary">{detail.label}</span>
            <span className="ml-auto flex min-w-0 items-start gap-3">
              {detail.value === undefined ? null : (
                <span className="min-w-0 break-words text-right text-sm font-medium text-primary">
                  {detail.value}
                </span>
              )}
              {detail.json ? (
                <Button type="button" size="xs" onClick={() => setJsonDetail(detail)}>
                  {t("DashboardPayments.ramps.memoViewJson")}
                </Button>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
