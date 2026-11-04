"use client";

import { Button } from "@sdp/ui/button";
import * as Sentry from "@sentry/nextjs";
import { TriangleAlert } from "lucide-react";
import { useEffect, useTransition } from "react";
import { useTranslations } from "@/i18n/provider";

/**
 * The `error.tsx` fallback shared by every segment boundary: it replaces only
 * the content its boundary wraps, so the layouts above it stay mounted.
 */
export function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations();
  const [isRetrying, startRetry] = useTransition();

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-2xl border border-border-default bg-surface-raised p-6 text-center">
        <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-[10px] border border-border-subtle bg-fill-subtle text-warning">
          <TriangleAlert className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </span>
        {/* h2, not h1: inside the dashboard the shell above this boundary owns the page title. */}
        <h2 className="mt-4 text-xl font-medium text-primary">{t("Error.viewTitle")}</h2>
        <p className="mt-2 text-sm leading-6 text-tertiary">{t("Error.viewDescription")}</p>
        <Button
          className="mt-5"
          loading={isRetrying}
          onClick={() => startRetry(retry)}
          type="button"
        >
          {t("Error.tryAgain")}
        </Button>
        {/* Quiet, but the one thing worth reading back to support. */}
        {error.digest ? (
          <p className="mt-4 text-xs text-tertiary">
            {t("Error.reference", { digest: error.digest })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
