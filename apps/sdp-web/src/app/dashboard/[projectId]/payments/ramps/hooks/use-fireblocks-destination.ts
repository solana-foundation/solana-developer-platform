"use client";

import { SOL_MINT } from "@sdp/types";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useProjectId } from "@/lib/use-dashboard-project";

type State = "approved" | "pending" | "not_whitelisted" | "unknown" | "failed";
type Result = {
  data: {
    state: State;
    assetId: string;
    failureReason?: "credentials" | "permissions" | "request";
    providerCode?: number;
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
/** Advisory only: selecting a destination performs reads; only the toast action proposes it. */
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
  const proposing = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled || !walletId || !counterpartyId || !accountId || !token || !address || !projectId)
      return;
    const input = { walletId, counterpartyId, accountId, token, address };
    const key = JSON.stringify([projectId, input]);
    const controller = new AbortController();
    let active = true;
    let toastId: string | number | undefined;
    const propose = async () => {
      if (!active || proposing.current.has(key)) return;
      proposing.current.add(key);
      const result = await dashboardFetch<Result>("/api/dashboard/fireblocks/whitelist", {
        method: "POST",
        body: input,
      });
      proposing.current.delete(key);
      // A proposal already sent remains real even if the selection changes; show its result.
      if (!result.ok) {
        toast.error(t("DashboardPayments.onchainSend.whitelistFailed"), {
          description: result.error,
        });
        return;
      }
      const { state, failureReason, providerCode } = result.data.data;
      if (state === "failed") {
        toast(
          t(
            failureReason === "credentials"
              ? "DashboardPayments.onchainSend.whitelistCredentials"
              : failureReason === "permissions"
                ? "DashboardPayments.onchainSend.whitelistPermissions"
                : "DashboardPayments.onchainSend.whitelistFailed"
          ),
          {
            duration: 10000,
            ...(providerCode === undefined
              ? {}
              : {
                  description: t("DashboardPayments.onchainSend.whitelistErrorCode", {
                    code: providerCode,
                  }),
                }),
          }
        );
        return;
      }
      toast(
        t(
          state === "approved"
            ? "DashboardPayments.onchainSend.whitelistApproved"
            : state === "pending"
              ? "DashboardPayments.onchainSend.whitelistPending"
              : "DashboardPayments.onchainSend.whitelistUnknown"
        ),
        { duration: 10000 }
      );
    };
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
      toastId = toast(t("DashboardPayments.onchainSend.whitelistOffer"), {
        description: t("DashboardPayments.onchainSend.whitelistDescription", {
          address: `${address.slice(0, 6)}…${address.slice(-6)}`,
          asset: token === "SOL" || token === SOL_MINT ? "SOL" : "USDC",
        }),
        duration: 15000,
        action: {
          label: t("DashboardPayments.onchainSend.whitelistAction"),
          onClick: () => {
            void propose();
          },
        },
        cancel: {
          label: t("DashboardPayments.onchainSend.whitelistDismiss"),
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
  }, [enabled, walletId, counterpartyId, accountId, token, address, projectId, t]);
}
