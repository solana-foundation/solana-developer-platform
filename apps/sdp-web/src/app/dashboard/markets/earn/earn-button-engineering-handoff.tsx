"use client";

import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";

export function EarnButtonEngineeringHandoff({
  previewOnly = false,
  shareLink,
  sharePath,
}: {
  previewOnly?: boolean;
  shareLink: string | null;
  sharePath: string | null;
}) {
  const t = useTranslations();
  const { copied, copy } = useCopy(1200);
  const hasShareLink = Boolean(shareLink && sharePath);

  return (
    <section className="rounded-xl border border-border-default bg-fill-subtle px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-primary">
              {t("DashboardMarkets.earnProgram.shareTitle")}
            </h3>
            <Badge variant="outline">{t("DashboardMarkets.earnProgram.handoffPublic")}</Badge>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-secondary">
            {t(
              previewOnly
                ? "DashboardMarkets.earnProgram.mainnetHandoffDescription"
                : "DashboardMarkets.earnProgram.shareDescription"
            )}
          </p>
        </div>
      </div>

      {hasShareLink ? (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border-default bg-surface-raised px-3 py-3 sm:flex-row sm:items-center">
          <a
            className="min-w-0 flex-1 truncate text-sm text-primary underline-offset-4 hover:underline"
            href={sharePath ?? undefined}
            rel="noreferrer"
            target="_blank"
            title={shareLink ?? undefined}
          >
            {shareLink}
          </a>
          <div className="flex shrink-0 gap-2">
            <Button
              iconLeft={copied ? <CheckIcon /> : <CopyIcon />}
              onClick={() => void copy(shareLink ?? "")}
              size="sm"
              variant="secondary"
            >
              {t(
                copied
                  ? "DashboardMarkets.earnProgram.copiedLink"
                  : "DashboardMarkets.earnProgram.copyLink"
              )}
            </Button>
            <Button asChild iconRight={<ExternalLinkIcon />} size="sm" variant="ghost">
              <a href={sharePath ?? undefined} rel="noreferrer" target="_blank">
                {t("DashboardMarkets.earnProgram.openLink")}
              </a>
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-xs font-medium text-secondary">
          {t(
            previewOnly
              ? "DashboardMarkets.earnProgram.mainnetHandoffUnavailable"
              : "DashboardMarkets.earnProgram.unsavedHandoff"
          )}
        </p>
      )}
    </section>
  );
}
