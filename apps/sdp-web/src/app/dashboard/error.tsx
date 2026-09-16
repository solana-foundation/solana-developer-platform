"use client";

import * as Sentry from "@sentry/nextjs";
import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";

// Without a boundary here, a throw in any dashboard page escapes all the way to
// app/global-error.tsx — which renders its own <html>/<body> and so replaces the
// whole document, taking the shell, the sidebar, and every client effect mounted
// inside it with it.
//
// Sitting under the layout means the chrome survives and only the content slot
// is replaced, so the rest of the dashboard stays navigable.
//
// Project selection is not a reason to land here any more: createSdpApiClient()
// resolves the sdp_selected_project_id cookie through the same chain the layout
// renders with (lib/dashboard-project-selection.ts), so a missing or stale
// cookie reads the sandbox project instead of throwing "Selected project
// required" or sending the API a project it refuses. What still arrives is a
// genuine failure: the API down, or an organization with no project at all.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [isRetrying, startRetry] = useTransition();

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  // The failure is usually server-side, so reset() alone would re-render the same
  // failed payload: refresh re-runs the server components, reset clears the
  // boundary once fresh output arrives.
  const retry = () => {
    startRetry(() => {
      router.refresh();
      reset();
    });
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-2xl border border-border-default bg-surface-raised p-6 text-center">
        <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-[10px] border border-border-subtle bg-fill-subtle text-warning">
          <TriangleAlert className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </span>
        {/* h2, not h1: the shell above this boundary already owns the page title. */}
        <h2 className="mt-4 text-xl font-medium text-primary">{t("Error.viewTitle")}</h2>
        <p className="mt-2 text-sm leading-6 text-tertiary">{t("Error.viewDescription")}</p>
        <Button className="mt-5" disabled={isRetrying} onClick={retry} type="button">
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
