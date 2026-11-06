"use client";

import { Button } from "@sdp/ui/button";
import { Card } from "@sdp/ui/card";
import { Modal } from "@sdp/ui/modal";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useModalFocus } from "@/lib/use-modal-focus";
import { shortenMarketAddress } from "./earn-format";
import { useEarnProviderOrders } from "./earn-provider-orders-data";

export function EarnProviderOrdersCard({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations(),
    canWrite = useCanWrite();
  const { orders, actions, error, failure, busy, selected, setSelected, setFailure, cancel } =
    useEarnProviderOrders(onChanged);
  const contentRef = useModalFocus({
    focusKey: selected?.movementId ?? "closed",
    initialFocusSelector: "[data-keep-provider-order]",
    fallbackAttribute: "data-earn-provider-order",
    fallbackValue: selected?.movementId ?? "closed",
  });
  if (orders.length === 0 && !error) return null;
  return (
    <section>
      <h2 className="mb-4 text-subheading font-medium text-primary">
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
                  {order.ownerAddress !== null ? (
                    <p className="text-xs text-secondary">
                      {t("DashboardEarn.providerAction.cancelWallet", {
                        wallet: shortenMarketAddress(order.ownerAddress),
                      })}
                    </p>
                  ) : null}
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
          {/* Equal-sized redemptions from different wallets render identical
              rows, so the confirmation names the target even when the
              movement's owner is unknown to the API. */}
          {selected !== null ? (
            <p className="text-sm font-medium text-primary">
              {selected.ownerAddress !== null
                ? t("DashboardEarn.providerAction.cancelTarget", {
                    wallet: shortenMarketAddress(selected.ownerAddress),
                    vault: shortenMarketAddress(selected.providerReference),
                  })
                : t("DashboardEarn.providerAction.cancelVault", {
                    vault: shortenMarketAddress(selected.providerReference),
                  })}
            </p>
          ) : null}
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
