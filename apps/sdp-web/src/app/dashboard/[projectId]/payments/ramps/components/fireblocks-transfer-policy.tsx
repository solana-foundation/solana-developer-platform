"use client";
import type { FireblocksPolicyCheck, FireblocksPolicySelection } from "@sdp/types";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useProjectId } from "@/lib/use-dashboard-project";
import { useFireblocksWarning } from "@/lib/use-fireblocks-warning";

type Reply<T> = { data: T };
export function FireblocksTransferPolicy({
  enabled,
  selection,
}: {
  enabled: boolean;
  selection: FireblocksPolicySelection;
}) {
  const t = useTranslations();
  const projectId = useProjectId();
  const [check, setCheck] = useState<FireblocksPolicyCheck | null>(null);
  const { suppressed, suppress, canSuppress, scopeKey } = useFireblocksWarning("policy");
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([scopeKey, projectId, selection, refresh]);
  const [resultKey, setResultKey] = useState("");
  const stableSelection = useRef(selection);
  if (JSON.stringify(stableSelection.current) !== JSON.stringify(selection))
    stableSelection.current = selection;
  useEffect(() => {
    if (
      suppressed ||
      !enabled ||
      !selection.walletId ||
      !selection.accountId ||
      !selection.address ||
      !selection.token ||
      !/^\d+(\.\d+)?$/.test(selection.amount) ||
      !projectId
    )
      return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => {
      void dashboardFetch<Reply<FireblocksPolicyCheck>>(
        `/api/dashboard/fireblocks/policy?${new URLSearchParams({ ...stableSelection.current })}`,
        { signal: controller.signal }
      ).then((reply) => {
        if (!active) return;
        setCheck(reply.ok ? reply.data.data : { state: "unknown" });
        setResultKey(key);
      });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    enabled,
    suppressed,
    key,
    projectId,
    selection.walletId,
    selection.accountId,
    selection.address,
    selection.token,
    selection.amount,
  ]);
  if (suppressed || !enabled || !check || check.state === "covered" || resultKey !== key)
    return null;
  const message = {
    missing: "DashboardPayments.fireblocksPolicy.missing",
    blocked: "DashboardPayments.fireblocksPolicy.blocked",
    unknown: "DashboardPayments.fireblocksPolicy.unknown",
    permission_required: "DashboardPayments.fireblocksPolicy.permissions",
  } as const;
  return (
    <div className="space-y-3 border-t border-border-default pt-4">
      <p className="text-sm text-secondary" role="status">
        {t(message[check.state])}
        {check.ruleName ? ` ${check.ruleName}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" onClick={() => setRefresh((value) => value + 1)}>
          {t("DashboardPayments.fireblocksPolicy.recheck")}
        </Button>
        <a
          href="https://console.fireblocks.io"
          target="_blank"
          rel="noreferrer"
          className="text-sm underline underline-offset-4"
        >
          {t("DashboardPayments.fireblocksPolicy.openFireblocks")}
        </a>
        {canSuppress ? (
          <Button
            type="button"
            variant="ghost"
            title={t("DashboardPayments.fireblocksWarnings.scope")}
            onClick={() => {
              if (!suppress()) toast.error(t("DashboardPayments.fireblocksWarnings.saveFailed"));
            }}
          >
            {t("DashboardPayments.fireblocksWarnings.suppress")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
