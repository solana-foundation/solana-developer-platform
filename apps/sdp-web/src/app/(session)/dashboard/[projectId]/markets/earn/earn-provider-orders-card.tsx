"use client";

import type { EarnVaultWithdrawal } from "@sdp/types/earn";
import type { EarnProviderAction } from "@sdp/types/earn-provider-orders";
import { earnCanCancelProviderOrder } from "@sdp/types/provider-access";
import { Button } from "@sdp/ui/button";
import { Card } from "@sdp/ui/card";
import { Modal } from "@sdp/ui/modal";
import { useEffect, useState } from "react";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";
import { useProjectId } from "@/lib/use-dashboard-project";
import { useModalFocus } from "@/lib/use-modal-focus";
import { shortenMarketAddress } from "./earn-format";
import { useEarnVaultWithdrawals } from "./earn-program-data";
import { createEarnProviderAction, fetchEarnProviderAction } from "./earn-provider-actions";

const cancellationKeys = createIdempotencyKeyStore("sdp:earn:provider-order-cancellation:v1");

export function EarnProviderOrdersCard({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations(),
    canWrite = useCanWrite(),
    projectId = useProjectId();
  const { withdrawals, error, refresh } = useEarnVaultWithdrawals();
  const [selected, setSelected] = useState<EarnVaultWithdrawal | null>(null);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, EarnProviderAction>>({});
  const contentRef = useModalFocus({
    focusKey: selected?.movementId ?? "closed",
    initialFocusSelector: "[data-keep-provider-order]",
    fallbackAttribute: "data-earn-provider-order",
    fallbackValue: selected?.movementId ?? "closed",
  });
  const orders = (withdrawals ?? []).filter(
    (row) => earnCanCancelProviderOrder(row.provider) && row.redemptionMode === "standard"
  );
  useEffect(() => {
    const pending = Object.entries(actions).filter(
      ([, action]) => !["finalized", "failed"].includes(action.status)
    );
    if (pending.length === 0) return;
    let active = true;
    const timer = setTimeout(() => {
      void Promise.all(
        pending.map(async ([movementId, action]) => {
          try {
            const next = await fetchEarnProviderAction(action.actionId);
            if (!active) return;
            setActions((current) => ({ ...current, [movementId]: next }));
            if (["finalized", "failed"].includes(next.status)) {
              refresh();
              onChanged?.();
            }
          } catch (cause) {
            if (active)
              setFailure(
                cause instanceof Error ? cause.message : t("DashboardEarn.providerAction.error")
              );
          }
        })
      );
    }, 5_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [actions, onChanged, refresh, t]);

  async function cancel() {
    if (!selected || busy) return;
    const fingerprint = JSON.stringify([projectId, selected.movementId]);
    const { key, persisted } = cancellationKeys.claim(fingerprint);
    if (!persisted) {
      setFailure(t("DashboardEarn.intentStorageUnavailable"));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const action = await createEarnProviderAction(
        "cancellations",
        { movementId: selected.movementId },
        key
      );
      setActions((current) => ({ ...current, [selected.movementId]: action }));
      if (action.status === "failed") {
        cancellationKeys.release(fingerprint, key);
        setFailure(action.error);
      }
      setSelected(null);
      refresh();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : t("DashboardEarn.providerAction.error"));
    } finally {
      setBusy(false);
    }
  }
  if (orders.length === 0 && !error) return null;
  return (
    <section>
      <h2 className="mb-4 text-[19px] font-medium leading-6 text-primary">
        {t("DashboardEarn.providerAction.title")}
      </h2>
      <Card className="overflow-hidden rounded-2xl py-0">
        {failure || error ? (
          <p className="px-6 py-4 text-sm text-error" role="alert">
            {failure ?? t("DashboardEarn.providerAction.error")}
          </p>
        ) : null}
        <ul className="divide-y divide-border-subtle">
          {orders.map((order) => {
            const action = actions[order.movementId];
            const pending = action !== undefined && action.status !== "failed";
            return (
              <li
                key={order.movementId}
                className="flex flex-wrap items-center justify-between gap-4 px-6 py-4"
              >
                <div>
                  <p className="text-sm font-medium text-primary">
                    {shortenMarketAddress(order.providerReference)} · {order.shares}
                  </p>
                  {pending ? (
                    <p className="mt-1 text-xs text-secondary" role="status">
                      {t("DashboardEarn.providerAction.checking")}
                    </p>
                  ) : null}
                </div>
                {canWrite ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || order.status !== "confirmed"}
                    data-earn-provider-order={order.movementId}
                    onClick={() => {
                      setSelected(order);
                      setFailure(null);
                    }}
                  >
                    {t("DashboardEarn.providerAction.cancel")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
      <Modal
        isOpen={selected !== null}
        closeDisabled={busy}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
        ariaLabel={t("DashboardEarn.providerAction.cancel")}
      >
        <div ref={contentRef} tabIndex={-1} className="space-y-5 p-6">
          <h2 className="text-lg font-medium text-primary">
            {t("DashboardEarn.providerAction.cancel")}
          </h2>
          <p className="text-sm text-secondary">
            {t("DashboardEarn.providerAction.cancelWarning")}
          </p>
          {failure ? (
            <p className="text-sm text-error" role="alert">
              {failure}
            </p>
          ) : null}
          <div className="flex justify-end gap-3">
            <Button
              data-keep-provider-order
              variant="outline"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              {t("DashboardEarn.providerAction.close")}
            </Button>
            <Button disabled={busy} onClick={() => void cancel()}>
              {t("DashboardEarn.providerAction.confirmCancel")}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
