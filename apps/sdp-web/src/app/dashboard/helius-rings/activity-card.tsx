"use client";

import { Loader2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  executeRingsOperation,
  type OperationResult,
  type ProjectRing,
  type RingsOperationState,
  type RingsOperationSummary,
  recheckRingsOperation,
  retryRingsOperation,
  voidRingsOperation,
} from "./helius-rings.data";
import {
  formatAssetAmount,
  formatWhen,
  isSettling,
  ringNameByProgramId,
  shortenOperationId,
  shortenShieldedAddress,
} from "./helius-rings.utils";

const STATE_BADGE: Record<RingsOperationState, "default" | "success" | "warning" | "danger"> = {
  draft: "default",
  preparing: "default",
  approval_required: "warning",
  proving: "default",
  ready_to_sign: "default",
  submitted: "default",
  indexing: "default",
  completed: "success",
  failed: "danger",
  voided: "default",
};

type RowAction =
  | { kind: "execute" }
  | { kind: "recheck" }
  | { kind: "void"; signature: string }
  | { kind: "retry" };

/**
 * What this operation offers an operator, in the order worth trying.
 *
 * A signed failure gets two. Rechecking asks the indexer again and can only
 * ever complete the row, so it leads: an indexer that has fallen behind the
 * chain is the likelier explanation than a transaction that never landed, and
 * asking costs one read. Voiding asserts the opposite and cannot be undone.
 *
 * `retriedBy` suppresses a second retry of the same failure. A retry files a
 * new operation rather than reusing this one, so nothing about this row changes
 * to record that it was already retried, and the button would otherwise stay
 * live and file a sibling every time it was pressed.
 */
function rowActions(operation: RingsOperationSummary, retriedBy: string | undefined): RowAction[] {
  if (operation.state === "approval_required") return [{ kind: "execute" }];

  // An operation waiting on the indexer offers a manual recheck so the
  // operator isn't watching a spinner with no recourse.
  if (operation.state === "indexing") return [{ kind: "recheck" }];

  if (operation.state !== "failed") return [];

  // A signed failure is voided, never retried: a retry would re-sign an intent
  // whose first transaction may still land.
  if (operation.failureCode === "manual_reconciliation_required") {
    return operation.outerTxSignature
      ? [{ kind: "recheck" }, { kind: "void", signature: operation.outerTxSignature }]
      : [];
  }
  if (retriedBy) return [];
  return operation.retryable === true ? [{ kind: "retry" }] : [];
}

/**
 * Which end of a retry link this row sits on, if either. Only the retry stores
 * the id it replaced, so the replaced operation is reachable solely by finding
 * the retry that names it.
 */
function rowLineage(
  operation: RingsOperationSummary,
  retriedBy: string | undefined
): { key: "retryOf" | "retriedAs"; operationId: string } | null {
  if (operation.retryOfOperationId) {
    return { key: "retryOf", operationId: operation.retryOfOperationId };
  }
  return retriedBy ? { key: "retriedAs", operationId: retriedBy } : null;
}

function runAction(
  operationId: string,
  action: RowAction,
  state: RingsOperationState
): Promise<OperationResult> {
  switch (action.kind) {
    case "execute":
      return executeRingsOperation(operationId);
    case "recheck":
      // `indexing` rows are advanced through the execute path (which polls
      // Photon). The dedicated recheck route only handles `failed` rows.
      return state === "indexing"
        ? executeRingsOperation(operationId)
        : recheckRingsOperation(operationId);
    case "void":
      return voidRingsOperation(operationId, action.signature);
    case "retry":
      return retryRingsOperation(operationId);
  }
}

const ACTION_LABELS = {
  execute: {
    idle: "DashboardHeliusRings.recovery.execute",
    busy: "DashboardHeliusRings.recovery.executing",
  },
  recheck: {
    idle: "DashboardHeliusRings.recovery.recheck",
    busy: "DashboardHeliusRings.recovery.rechecking",
  },
  void: {
    idle: "DashboardHeliusRings.recovery.void",
    busy: "DashboardHeliusRings.recovery.voiding",
  },
  retry: {
    idle: "DashboardHeliusRings.recovery.retry",
    busy: "DashboardHeliusRings.recovery.retrying",
  },
} as const;

/**
 * Every operation in one table, with whatever it needs from an operator on the
 * row itself.
 *
 * Recovery used to be a separate card, which meant a failed operation appeared
 * twice and its action lived away from the row explaining why it was needed.
 */
export function ActivityCard({
  operations,
  projectRings,
  onChanged,
  onSelect,
}: {
  operations: RingsOperationSummary[];
  /** Names the ring pinned on each row; unknown ids fall back to the truncated program id. */
  projectRings: ProjectRing[];
  onChanged: () => Promise<void>;
  onSelect: (operationId: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [busy, setBusy] = useState<{ id: string; kind: RowAction["kind"] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A recheck that finds nothing leaves the row exactly as it was, so without
  // this the button would look like it did nothing at all.
  const [notice, setNotice] = useState<string | null>(null);

  const ringNames = useMemo(() => ringNameByProgramId(projectRings), [projectRings]);

  const retriedBy = useMemo(() => {
    const successors = new Map<string, string>();
    for (const operation of operations) {
      if (operation.retryOfOperationId) successors.set(operation.retryOfOperationId, operation.id);
    }
    return successors;
  }, [operations]);

  const handleAction = useCallback(
    async (operationId: string, action: RowAction, state: RingsOperationState) => {
      // Voiding asserts the transaction never landed, so it is the one action
      // an operator has to affirm.
      if (
        action.kind === "void" &&
        !window.confirm(t("DashboardHeliusRings.recovery.voidConfirm"))
      ) {
        return;
      }

      setBusy({ id: operationId, kind: action.kind });
      setError(null);
      setNotice(null);
      try {
        const result = await runAction(operationId, action, state);
        if (result.error) {
          setError(result.error);
        } else if (action.kind === "recheck") {
          setNotice(
            t(
              result.operation?.state === "completed"
                ? "DashboardHeliusRings.recovery.recheckFound"
                : "DashboardHeliusRings.recovery.recheckStillMissing"
            )
          );
        }
        await onChanged();
      } finally {
        setBusy(null);
      }
    },
    [onChanged, t]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.activity.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.activity.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? (
          <Callout variant="danger" live>
            {error}
          </Callout>
        ) : null}
        {notice ? (
          <Callout variant="info" live>
            {notice}
          </Callout>
        ) : null}
        {operations.length === 0 ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.activity.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardHeliusRings.activity.operation")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.state")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.amount")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.ring")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.created")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.action")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {operations.map((operation) => {
                const successor = retriedBy.get(operation.id);
                const actions = rowActions(operation, successor);
                const lineage = rowLineage(operation, successor);
                const rowBusy = busy?.id === operation.id;
                return (
                  <TableRow
                    key={operation.id}
                    className="cursor-pointer"
                    onClick={() => onSelect(operation.id)}
                  >
                    <TableCell>
                      <span className="flex flex-col items-start gap-0.5">
                        {t(`DashboardHeliusRings.activity.opType_${operation.opType}`)}
                        {lineage ? (
                          <button
                            type="button"
                            className="text-xs text-secondary underline underline-offset-2"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelect(lineage.operationId);
                            }}
                          >
                            {t(`DashboardHeliusRings.activity.${lineage.key}`, {
                              id: shortenOperationId(lineage.operationId),
                            })}
                          </button>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Badge variant={STATE_BADGE[operation.state]}>
                          {t(`DashboardHeliusRings.activity.state_${operation.state}`)}
                        </Badge>
                        {isSettling(operation.state) ? (
                          <Loader2Icon
                            className="size-3.5 animate-spin text-secondary"
                            aria-label={t("DashboardHeliusRings.activity.working")}
                          />
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      {formatAssetAmount(operation.amountRaw, operation.assetMint)}
                    </TableCell>
                    <TableCell>
                      {operation.ringProgramId === null
                        ? t("DashboardHeliusRings.activity.ringDefault")
                        : (ringNames.get(operation.ringProgramId) ??
                          shortenShieldedAddress(operation.ringProgramId))}
                    </TableCell>
                    <TableCell>{formatWhen(operation.createdAt, locale)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        {actions.map((action) => (
                          <Button
                            key={action.kind}
                            // Void is the irreversible one, so it never wears
                            // the same weight as the observation beside it.
                            variant={action.kind === "void" ? "ghost" : "secondary"}
                            size="sm"
                            // One request per row at a time: the actions read
                            // and write the same operation.
                            disabled={rowBusy}
                            // The row opens the detail drawer, which is not
                            // what someone aiming at the button asked for.
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleAction(operation.id, action, operation.state);
                            }}
                          >
                            {t(
                              ACTION_LABELS[action.kind][
                                rowBusy && busy?.kind === action.kind ? "busy" : "idle"
                              ]
                            )}
                          </Button>
                        ))}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
