"use client";

import type { EarnStrategy, EarnVaultPosition } from "@sdp/types/earn";
import type { Operation } from "@sdp/types/operations";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { isEarnOperationTerminal, useEarnOperations } from "@/lib/earn-core-data";
import { EarnOperationReview } from "./earn-core-action-modal";
import { formatTokenValue } from "./earn-format";

/** Pending work survives the action dialog and reloads through the shared operation feed. */
export function EarnCoreOperations({
  onUpdated,
  strategies,
  positions,
}: {
  onUpdated: (operation: Operation) => void;
  strategies?: readonly Pick<EarnStrategy, "id" | "name">[];
  positions?: readonly Pick<EarnVaultPosition, "id" | "label">[];
}) {
  const t = useTranslations();
  const { operations, activeIds, error, hasMore, isLoadingMore, isRefreshing, loadMore, refresh } =
    useEarnOperations();
  if (!operations?.length && !error) return null;
  const activeOperationIds = new Set(activeIds);
  return (
    <section className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-subheading font-medium text-primary">
          {t("DashboardEarn.core.operations")}
        </h2>
        <Button
          variant="secondary"
          disabled={isLoadingMore || isRefreshing}
          onClick={() => void refresh()}
        >
          {t("DashboardMarkets.treasury.refresh")}
        </Button>
      </div>
      {error ? <Callout variant="warning">{t("DashboardEarn.core.refreshFailed")}</Callout> : null}
      {operations?.map((operation) => {
        const intent = operation.intent;
        const strategyName =
          intent.kind === "earn.deposit"
            ? strategies?.find((strategy) => strategy.id === intent.strategyId)?.name
            : (positions?.find(
                (position) =>
                  position.id === intent.positionId || position.id === operation.result?.positionId
              )?.label ??
              strategies?.find((strategy) => strategy.id === operation.result?.strategyId)?.name);
        return (
          <EarnCoreOperationRow
            key={operation.id}
            operation={operation}
            strategyName={strategyName}
            observeInitialTerminal={activeOperationIds.has(operation.id)}
            onUpdated={onUpdated}
          />
        );
      })}
      {hasMore ? (
        <Button variant="secondary" loading={isLoadingMore} onClick={() => void loadMore()}>
          {t("Shared.SharedComponents.loadMore")}
        </Button>
      ) : null}
    </section>
  );
}

function EarnCoreOperationRow({
  operation,
  strategyName,
  observeInitialTerminal,
  onUpdated,
}: {
  operation: Operation;
  strategyName: string | undefined;
  observeInitialTerminal: boolean;
  onUpdated: (operation: Operation) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const terminal = isEarnOperationTerminal(operation);
  const wasActive = useRef(!terminal || observeInitialTerminal);
  useEffect(() => {
    const completedWhileVisible = wasActive.current && terminal;
    wasActive.current = !terminal;
    // The feed can finish first and remove the detail poll before its callback.
    if (completedWhileVisible) onUpdated(operation);
  }, [onUpdated, operation, terminal]);
  const settled = operation.result?.settledAmount;
  const requested = operation.intent.kind === "earn.deposit" ? operation.intent.amount : null;
  const title =
    operation.kind === "earn.deposit"
      ? t("DashboardEarn.core.deposit")
      : t("DashboardEarn.core.withdraw");
  return (
    <article className="border-b border-default pb-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-body font-medium text-primary">
          {title}
          {requested ? `: ${formatTokenValue(requested.value, requested.mint, locale)}` : ""}
        </h3>
        {terminal ? (
          <span className="text-body text-secondary">
            {t(`DashboardEarn.core.status.${operation.status}` as const)}
          </span>
        ) : null}
      </div>
      {strategyName ? <p className="mt-2 text-body text-secondary">{strategyName}</p> : null}
      {settled ? (
        <p className="mt-2 text-body text-secondary">
          {t(
            operation.result?.settlementOutcome === "recovered"
              ? "DashboardEarn.core.recovered"
              : operation.result?.settlementOutcome === "cancelled"
                ? "DashboardEarn.core.returned"
                : "DashboardEarn.core.delivered"
          )}
          : {formatTokenValue(settled.value, settled.mint, locale)}
        </p>
      ) : null}
      {!terminal ? <EarnOperationReview operation={operation} onUpdated={onUpdated} /> : null}
    </article>
  );
}
