"use client";

import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useProjectId } from "@/lib/use-dashboard-project";
import { useFireblocksWarning } from "@/lib/use-fireblocks-warning";

type State = "approved" | "pending" | "not_whitelisted" | "unknown" | "failed";
type Result = {
  data: {
    state: State;
    assetId: string;
  };
};
interface Selection {
  enabled: boolean;
  walletId: string;
  counterpartyId: string;
  accountId: string;
  token: string | null;
  address: string | null;
}
/** Advisory only. Whitelist changes are made by the customer in Fireblocks. */
export function useFireblocksDestination({
  enabled,
  walletId,
  counterpartyId,
  accountId,
  token,
  address,
}: Selection) {
  const t = useTranslations();
  const projectId = useProjectId();
  const offered = useRef(new Set<string>());
  const { suppressed, suppress, canSuppress, scopeKey } = useFireblocksWarning("whitelist");
  useEffect(() => {
    if (
      suppressed ||
      !enabled ||
      !walletId ||
      !counterpartyId ||
      !accountId ||
      !token ||
      !address ||
      !projectId
    )
      return;
    const input = { walletId, counterpartyId, accountId, token, address };
    const key = JSON.stringify([scopeKey, projectId, input]);
    const controller = new AbortController();
    let active = true;
    let toastId: string | number | undefined;
    const timer = setTimeout(async () => {
      const result = await dashboardFetch<Result>(
        `/api/dashboard/fireblocks/destination?${new URLSearchParams(input)}`,
        { signal: controller.signal }
      );
      if (
        !active ||
        !result.ok ||
        result.data.data.state !== "not_whitelisted" ||
        offered.current.has(key)
      )
        return;
      offered.current.add(key);
      toastId = toast.message(t("DashboardPayments.onchainSend.whitelistWarning"), {
        description: t("DashboardPayments.onchainSend.whitelistDescription", {
          address: `${address.slice(0, 6)}…${address.slice(-6)}`,
          asset: token === "SOL" || token === SOL_MINT ? "SOL" : "USDC",
        }),
        duration: 15000,
        style: { flexWrap: "wrap" },
        classNames: { content: "!basis-full" },
        action: canSuppress
          ? {
              label: t("DashboardPayments.fireblocksWarnings.suppress"),
              onClick: () => {
                if (active && !suppress()) {
                  toast.error(t("DashboardPayments.fireblocksWarnings.saveFailed"));
                  offered.current.delete(key);
                }
              },
            }
          : undefined,
        cancel: {
          label: t("DashboardPayments.fireblocksWarnings.dismiss"),
          onClick: () => undefined,
        },
      });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
      if (toastId !== undefined) toast.dismiss(toastId);
    };
  }, [
    enabled,
    walletId,
    counterpartyId,
    accountId,
    token,
    address,
    projectId,
    t,
    suppressed,
    suppress,
    canSuppress,
    scopeKey,
  ]);
}
