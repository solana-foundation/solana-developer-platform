"use client";

import type { EarnStrategy, EarnVaultPosition } from "@sdp/types/earn";
import type { Operation } from "@sdp/types/operations";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { cn } from "@sdp/ui/cn";
import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { isEarnOperationTerminal, useEarnOperations } from "@/lib/earn-core-data";
import { EarnOperationReview } from "./earn-core-action-modal";
import { formatTokenValue } from "./earn-format";

/** How a settled amount reads: a recovery releases assets and a cancellation returns them. */
const SETTLED_MESSAGE = {
  delivered: "DashboardEarn.core.delivered",
  cancelled: "DashboardEarn.core.returned",
  recovered: "DashboardEarn.core.recovered",
} as const satisfies Record<
  NonNullable<NonNullable<Operation["result"]>["settlementOutcome"]>,
  string
>;

/**
 * Where a withdrawal waiting on its provider request can reopen its position's exit. The parent
 * decides which positions qualify and who may act; without it the feed offers no recovery.
 */
export interface EarnWithdrawalRecovery<Position extends Pick<EarnVaultPosition, "id">> {
  /** Positions the holdings list no longer offers an exit for. */
  positions: readonly Position[];
  /** Opens a withdrawal of All, where the API offers any recovery route that applies. */
  onOpen: (position: Position) => void;
}

/**
 * A withdrawal whose provider request landed and has not resolved. An expired request keeps
 * this state, and its escrow returns only through a new withdrawal the API prepares.
 */
function awaitsProviderRequest(operation: Operation): boolean {
  return (
    operation.kind === "earn.withdraw" &&
    operation.status === "settling" &&
    operation.resourceRef?.kind === "earn.withdrawal_request"
  );
}

/** A withdrawal names its position by intent, or by the recorded one once SDP tracks it. */
function isWithdrawalPosition(operation: Operation, positionId: string): boolean {
  return (
    (operation.intent.kind === "earn.withdraw" && operation.intent.positionId === positionId) ||
    operation.result?.positionId === positionId
  );
}

/** Pending work survives the action dialog and reloads through the shared operation feed. */
export function EarnCoreOperations<RecoverablePosition extends Pick<EarnVaultPosition, "id">>({
  onUpdated,
  strategies,
  positions,
  withdrawalRecovery,
}: {
  onUpdated: (operation: Operation) => void;
  strategies?: readonly Pick<EarnStrategy, "id" | "name">[];
  positions?: readonly Pick<EarnVaultPosition, "id" | "label">[];
  withdrawalRecovery?: EarnWithdrawalRecovery<RecoverablePosition>;
}) {
  const t = useTranslations();
  const { operations, activeIds, error, hasMore, isLoadingMore, isRefreshing, loadMore, refresh } =
    useEarnOperations();
  if (!operations?.length && !error) return null;
  const activeOperationIds = new Set(activeIds);
  const recoveryFor = (operation: Operation): (() => void) | undefined => {
    if (!withdrawalRecovery) return undefined;
    const position = withdrawalRecovery.positions.find(({ id }) =>
      isWithdrawalPosition(operation, id)
    );
    return position ? () => withdrawalRecovery.onOpen(position) : undefined;
  };
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
            : (positions?.find((position) => isWithdrawalPosition(operation, position.id))?.label ??
              strategies?.find((strategy) => strategy.id === operation.result?.strategyId)?.name);
        // The positions read that decides the action can land after this feed, so a row that
        // may offer it keeps the action's height from its first render.
        const recoverySlot = withdrawalRecovery !== undefined && awaitsProviderRequest(operation);
        return (
          <EarnCoreOperationRow
            key={operation.id}
            operation={operation}
            strategyName={strategyName}
            observeInitialTerminal={activeOperationIds.has(operation.id)}
            onUpdated={onUpdated}
            recoverySlot={recoverySlot}
            onRecover={recoverySlot ? recoveryFor(operation) : undefined}
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
  recoverySlot,
  onRecover,
}: {
  operation: Operation;
  strategyName: string | undefined;
  observeInitialTerminal: boolean;
  onUpdated: (operation: Operation) => void;
  recoverySlot: boolean;
  onRecover: (() => void) | undefined;
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
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3",
          recoverySlot && "min-h-[var(--button-height-md)]"
        )}
      >
        <h3 className="text-body font-medium text-primary">
          {title}
          {requested ? `: ${formatTokenValue(requested.value, requested.mint, locale)}` : ""}
        </h3>
        {terminal ? (
          <span className="text-body text-secondary">
            {t(`DashboardEarn.core.status.${operation.status}` as const)}
          </span>
        ) : null}
        {!terminal && onRecover ? (
          <Button size="sm" variant="secondary" onClick={onRecover}>
            {t("DashboardEarn.core.recoveryOptions")}
          </Button>
        ) : null}
      </div>
      {strategyName ? <p className="mt-2 text-body text-secondary">{strategyName}</p> : null}
      {settled ? (
        <p className="mt-2 text-body text-secondary">
          {t(SETTLED_MESSAGE[operation.result?.settlementOutcome ?? "delivered"])}:{" "}
          {formatTokenValue(settled.value, settled.mint, locale)}
        </p>
      ) : null}
      {!terminal ? <EarnOperationReview operation={operation} onUpdated={onUpdated} /> : null}
    </article>
  );
}
