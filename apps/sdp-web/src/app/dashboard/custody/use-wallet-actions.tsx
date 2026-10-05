"use client";

import type { SolanaCluster } from "@sdp/types";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  checkWalletSignerMemoAction,
  requestDevnetSolanaFaucetAction,
} from "@/app/dashboard/custody/actions";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";

/**
 * The faucet only funds devnet regardless of the project being viewed, so its
 * explorer link is pinned to devnet rather than following `useSolanaCluster()`
 * — using the active cluster would point a devnet signature at mainnet
 * explorer for anyone viewing a production project. (The signer check no
 * longer links anywhere: it is verified in simulation and never broadcast.)
 */
const ACTION_EXPLORER_CLUSTER = "devnet" satisfies SolanaCluster;

/** A signer check that passed in this session; the API keeps no record of one. */
export interface WalletOwnershipProof {
  at: string;
  signature: string;
}

/**
 * A wallet's two quick actions, prove ownership (a memo signed in simulation) and devnet SOL
 * from the faucet, each reported by toast. Shared by the actions menu and the wallet's page.
 */
export function useWalletActions({
  walletId,
  walletAddress,
  supportsSignerCheck = true,
}: {
  walletId: string;
  walletAddress: string;
  supportsSignerCheck?: boolean;
}) {
  const t = useTranslations();
  const { dashboardAccess, sandboxProject } = useDashboardWorkspace();
  const [isBusy, startTransition] = useTransition();
  const [lastProof, setLastProof] = useState<WalletOwnershipProof | null>(null);
  const canRunSignerCheck =
    supportsSignerCheck && dashboardAccess.capabilities.canUseWalletSignerCheck;

  const runSignerCheck = () => {
    if (!sandboxProject) {
      toast.error(t("DashboardCustody.sandboxProjectUnavailable"), {
        position: "bottom-right",
      });
      return;
    }

    const toastId = toast.loading(t("DashboardCustody.sendingSignerCheck"), {
      position: "bottom-right",
    });

    startTransition(() => {
      void (async () => {
        const result = await checkWalletSignerMemoAction(walletId).catch((error) => ({
          status: "error" as const,
          message: error instanceof Error ? error.message : t("DashboardCustody.signerCheckFailed"),
        }));

        if (result.status === "success") {
          setLastProof({ at: new Date().toISOString(), signature: result.signature });
          // The check is verified in simulation and never broadcast, so there
          // is no on-chain transaction to link — an explorer URL for this
          // signature would always 404.
          toast.success(t("DashboardCustody.signerCheckSent"), {
            id: toastId,
            description: t("DashboardCustody.memoTransactionSubmitted"),
            position: "bottom-right",
          });
          return;
        }

        toast.error(t("DashboardCustody.signerCheckFailed"), {
          id: toastId,
          description: result.message,
          position: "bottom-right",
        });
      })();
    });
  };

  const requestDevnetSol = () => {
    const toastId = toast.loading(t("DashboardCustody.requestingDevnetSol"), {
      position: "bottom-right",
    });

    startTransition(() => {
      void (async () => {
        const result = await requestDevnetSolanaFaucetAction(walletId, walletAddress).catch(
          (error) => ({
            status: "error" as const,
            message:
              error instanceof Error ? error.message : t("DashboardCustody.devnetFaucetFailed"),
          })
        );

        if (result.status === "success") {
          const explorerUrl = explorerTxUrl(result.signature, ACTION_EXPLORER_CLUSTER);

          toast.success(t("DashboardCustody.devnetSolRequested", { amount: result.amountSol }), {
            id: toastId,
            description: (
              <span>
                {t("DashboardCustody.faucetTransactionSubmitted")}{" "}
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  {t("DashboardCustody.viewOnSolanaExplorer")}
                </a>
              </span>
            ),
            position: "bottom-right",
          });
          return;
        }

        toast.error(t("DashboardCustody.devnetFaucetFailed"), {
          id: toastId,
          description: result.message,
          position: "bottom-right",
        });
      })();
    });
  };

  return { isBusy, canRunSignerCheck, runSignerCheck, requestDevnetSol, lastProof };
}
