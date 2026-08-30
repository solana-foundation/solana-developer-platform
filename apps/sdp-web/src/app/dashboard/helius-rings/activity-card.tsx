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
  type RingsOperationState,
  type RingsOperationSummary,
  retryRingsOperation,
  voidRingsOperation,
} from "./helius-rings.data";
import {
  formatAssetAmount,
  formatWhen,
  isSettling,
  shortenOperationId,
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

type RowAction = { kind: "execute" } | { kind: "void"; signature: string } | { kind: "retry" };

/**
 * The single action this operation offers an operator, if any.
 *
 * `retriedBy` suppresses a second retry of the same failure. A retry files a
 * new operation rather than reusing this one, so nothing about this row changes
 * to record that it was already retried, and the button would otherwise stay
 * live and file a sibling every time it was pressed.
 */
function rowAction(
  operation: RingsOperationSummary,
  retriedBy: string | undefined
): RowAction | null {
  if (operation.state === "approval_required") return { kind: "execute" };
  if (operation.state !== "failed") return null;

  // A signed failure is voided, never retried: a retry would re-sign an intent
  // whose first transaction may still land.
  if (operation.failureCode === "manual_reconciliation_required") {
    return operation.outerTxSignature
      ? { kind: "void", signature: operation.outerTxSignature }
      : null;
  }
  if (retriedBy) return null;
  return operation.retryable === true ? { kind: "retry" } : null;
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

const ACTION_LABELS = {
  execute: {
    idle: "DashboardHeliusRings.recovery.execute",
    busy: "DashboardHeliusRings.recovery.executing",
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
  onChanged,
  onSelect,
}: {
  operations: RingsOperationSummary[];
  onChanged: () => Promise<void>;
  onSelect: (operationId: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retriedBy = useMemo(() => {
    const successors = new Map<string, string>();
    for (const operation of operations) {
      if (operation.retryOfOperationId) successors.set(operation.retryOfOperationId, operation.id);
    }
    return successors;
  }, [operations]);

  const handleAction = useCallback(
    async (operationId: string, action: RowAction) => {
      // Voiding asserts the transaction never landed, so it is the one action
      // an operator has to affirm.
      if (
        action.kind === "void" &&
        !window.confirm(t("DashboardHeliusRings.recovery.voidConfirm"))
      ) {
        return;
      }

      setBusyId(operationId);
      setError(null);
      try {
        const result =
          action.kind === "execute"
            ? await executeRingsOperation(operationId)
            : action.kind === "void"
              ? await voidRingsOperation(operationId, action.signature)
              : await retryRingsOperation(operationId);
        if (result.error) setError(result.error);
        await onChanged();
      } finally {
        setBusyId(null);
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
        {operations.length === 0 ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.activity.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardHeliusRings.activity.operation")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.state")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.amount")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.created")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.action")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {operations.map((operation) => {
                const successor = retriedBy.get(operation.id);
                const action = rowAction(operation, successor);
                const lineage = rowLineage(operation, successor);
                const busy = busyId === operation.id;
                const label = action && ACTION_LABELS[action.kind][busy ? "busy" : "idle"];
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
                        {/* The badge alone cannot say whether a state is a stop
                            or a step; the spinner is what marks the row live. */}
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
                    <TableCell>{formatWhen(operation.createdAt, locale)}</TableCell>
                    <TableCell>
                      {action && label ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          // The row opens the detail drawer, which is not what
                          // someone aiming at the button asked for.
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleAction(operation.id, action);
                          }}
                        >
                          {t(label)}
                        </Button>
                      ) : null}
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
