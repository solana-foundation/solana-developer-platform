"use client";

import type { EarnVaultPosition, EarnVaultWithdrawal, SdpEnvironment } from "@sdp/types";
import { Clock3Icon, Loader2Icon, ZapIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { shortenMarketAddress } from "./earn-market-presentation";
import { fetchEarnVaultWithdrawalOptions } from "./earn-program-data";
import { EarnVaultAsyncWithdrawModal } from "./earn-vault-async-withdraw-modal";
import {
  type EarnVaultAsyncWithdrawalEvent,
  earnVaultAsyncWithdrawalRoute,
} from "./earn-vault-async-withdrawal";
import { EarnVaultWithdrawModal } from "./earn-vault-withdraw-modal";

interface EarnVaultExitModalProps {
  environment: SdpEnvironment;
  onClose: () => void;
  onMovementUpdated?: (withdrawal: EarnVaultWithdrawal) => void;
  onAsyncRequest?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onAsyncRequestSettled?: (event: EarnVaultAsyncWithdrawalEvent) => void;
  onWithdrawn?: (
    withdrawal: EarnVaultWithdrawal,
    intent: { amount: string; projectBalance: boolean }
  ) => void;
  position: EarnVaultPosition;
  projectId: string | null;
}

type RouteChoice = "instant" | "async";

/**
 * Resolves provider capabilities first and makes the user choose when both
 * routes exist. A long-lived request and an instant payout are never
 * interchangeable outcomes, so this component never applies a preference or
 * fallback. Mechanism dispatch is isolated from this provider-neutral chooser.
 */
export function EarnVaultExitModal(props: EarnVaultExitModalProps) {
  const { position } = props;
  const t = useTranslations();
  const [choice, setChoice] = useState<RouteChoice | null>(null);
  const [options, setOptions] = useState<
    Awaited<ReturnType<typeof fetchEarnVaultWithdrawalOptions>> | undefined
  >(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void fetchEarnVaultWithdrawalOptions(position.id, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setOptions(result);
      if (result.kind !== "ready") return;
      const asyncRoute = earnVaultAsyncWithdrawalRoute(result.value);
      if (result.value.instant && !asyncRoute) setChoice("instant");
      if (!result.value.instant && asyncRoute) setChoice("async");
    });
    return () => controller.abort();
  }, [position.id]);

  if (choice === "instant") {
    return (
      <EarnVaultWithdrawModal
        environment={props.environment}
        onClose={props.onClose}
        onMovementUpdated={props.onMovementUpdated}
        onWithdrawn={props.onWithdrawn}
        position={position}
        projectId={props.projectId}
      />
    );
  }

  const ready = options?.kind === "ready" ? options.value : null;
  const asyncRoute = ready ? earnVaultAsyncWithdrawalRoute(ready) : null;

  if (choice === "async" && asyncRoute) {
    return (
      <EarnVaultAsyncWithdrawModal
        environment={props.environment}
        onClose={props.onClose}
        onRequested={props.onAsyncRequest}
        onSettled={props.onAsyncRequestSettled}
        position={position}
        projectId={props.projectId}
        route={asyncRoute}
      />
    );
  }

  const positionName = position.label || shortenMarketAddress(position.providerReference);
  const modalLabel = t("DashboardEarn.exitRoute.title", { position: positionName });

  return (
    <Modal isOpen ariaLabel={modalLabel} onClose={props.onClose} size="md">
      <div className="p-6">
        <h2
          className="pr-8 text-lg font-medium leading-6 text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {modalLabel}
        </h2>
        {!options ? (
          <div className="mt-5 flex items-center gap-2 text-sm text-secondary" role="status">
            <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
            {t("DashboardEarn.exitRoute.loading")}
          </div>
        ) : options.kind === "unavailable" ? (
          <div className="mt-5 rounded-xl border border-warning-border bg-warning-bg p-4">
            <p className="text-sm text-warning">{t("DashboardEarn.exitRoute.unavailable")}</p>
            <Button
              className="mt-3"
              onClick={() => {
                setOptions(undefined);
                void fetchEarnVaultWithdrawalOptions(position.id).then(setOptions);
              }}
              size="sm"
              variant="outline"
            >
              {t("DashboardEarn.exitRoute.retry")}
            </Button>
          </div>
        ) : !ready?.instant && !asyncRoute ? (
          <p className="mt-5 text-sm text-warning">{t("DashboardEarn.exitRoute.none")}</p>
        ) : (
          <>
            <p className="mt-2 text-sm leading-5 text-secondary">
              {t("DashboardEarn.exitRoute.description")}
            </p>
            <div className="mt-5 grid gap-3">
              {ready?.instant ? (
                <button
                  className="rounded-xl border border-border-default bg-surface-raised p-4 text-left transition-colors hover:border-border-strong hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => setChoice("instant")}
                  type="button"
                >
                  <span className="flex items-center gap-2 font-medium text-primary">
                    <ZapIcon aria-hidden="true" className="size-4" />
                    {t("DashboardEarn.exitRoute.instantTitle")}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-secondary">
                    {t("DashboardEarn.exitRoute.instantDescription")}
                  </span>
                </button>
              ) : null}
              {asyncRoute ? (
                <button
                  className="rounded-xl border border-border-default bg-surface-raised p-4 text-left transition-colors hover:border-border-strong hover:bg-fill-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => setChoice("async")}
                  type="button"
                >
                  <span className="flex items-center gap-2 font-medium text-primary">
                    <Clock3Icon aria-hidden="true" className="size-4" />
                    {t("DashboardEarn.exitRoute.asyncTitle")}
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-secondary">
                    {t(asyncRoute.summary.messageKey, asyncRoute.summary.values)}
                  </span>
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
