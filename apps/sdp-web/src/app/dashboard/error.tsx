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
// inside it with it. That is more than a cosmetic difference: the organization
// onboarding redirect lives in a DashboardShell effect, so a page that throws
// before onboarding is complete used to leave the user stranded on a bare error
// page instead of being sent to /dashboard/onboarding.
//
// Sitting under the layout means the chrome survives and only the content slot
// is replaced, so the redirect still fires and the rest of the dashboard stays
// navigable.
//
// Note this catches the symptom, not the cause: project-scoped pages reach
// createSdpApiClient(), which throws "Selected project required" when the
// sdp_selected_project_id cookie is missing, while the layout's own
// resolveDashboardProjectSelection tolerates exactly that case by falling back
// to the sandbox project. Reconciling those two is a separate change.
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
