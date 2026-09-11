"use client";

import { useEffect, useState } from "react";
import DashboardLoading from "@/app/dashboard/(home)/loading";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { WORKSPACE_LOADING_RETRY_MS } from "@/lib/workspace-loading";

export function WorkspaceLoadingRefresh({ returnTo }: { returnTo: string }) {
  const t = useTranslations();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<"sync" | "access" | "service" | null>(null);
  const message =
    failure === "sync"
      ? "Shared.quickStart.syncDelayed"
      : failure === "access"
        ? "Shared.quickStart.accessDelayed"
        : failure === "service"
          ? "Shared.quickStart.serviceDelayed"
          : "Shared.quickStart.preparing";
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry starts a new bounded polling window.
  useEffect(() => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    let reason: "sync" | "access" | "service" = "sync";
    const deadline = setTimeout(() => {
      setFailure(reason);
      controller.abort();
    }, 30_000);
    async function poll() {
      try {
        const response = await fetch("/api/workspace-status", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.status === 401) {
          clearTimeout(deadline);
          window.location.replace(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
          return;
        }
        if (!response.ok) throw new Error("Workspace unavailable");
        const result = await response.json();
        if (controller.signal.aborted) return;
        if (result.state === "ready") {
          clearTimeout(deadline);
          window.location.replace(returnTo);
          return;
        }
        reason =
          result.reason === "access" ? "access" : result.reason === "service" ? "service" : "sync";
      } catch {
        reason = "service";
      }
      if (controller.signal.aborted) return;
      timeout = setTimeout(poll, WORKSPACE_LOADING_RETRY_MS);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timeout);
      clearTimeout(deadline);
    };
  }, [returnTo, attempt]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-10 sm:px-8">
      <div className="mb-8 flex min-h-12 items-center justify-between gap-4" role="status">
        <p className="text-sm text-secondary">{t(message)}</p>
        {failure ? (
          <Button
            variant="secondary"
            onClick={() => {
              setFailure(null);
              setAttempt((value) => value + 1);
            }}
          >
            {t("Shared.quickStart.retry")}
          </Button>
        ) : null}
      </div>
      <div aria-hidden="true" className={failure ? "[&_*]:animate-none" : undefined}>
        <DashboardLoading />
      </div>
    </main>
  );
}
