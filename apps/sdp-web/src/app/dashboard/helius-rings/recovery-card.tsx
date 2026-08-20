"use client";

import { useCallback, useState } from "react";
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
  type RingsOperationSummary,
  retryRingsOperation,
} from "./helius-rings.data";
import { formatWhen } from "./helius-rings.utils";

/**
 * The two states an operation rests in waiting on a human: `approval_required`
 * (execute it) and `failed` (file a retry). Both verdicts are enforced
 * server-side — the approval is read from the stored request, and retryability
 * rejects non-retryable failures and exhausted chains — so this card only
 * relays the outcome.
 */
export function RecoveryCard({
  operations,
  onChanged,
}: {
  operations: RingsOperationSummary[];
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const waiting = operations.filter(
    (operation) => operation.state === "approval_required" || operation.state === "failed"
  );

  const handleAction = useCallback(
    async (operation: RingsOperationSummary) => {
      setBusyId(operation.id);
      setError(null);
      const result =
        operation.state === "approval_required"
          ? await executeRingsOperation(operation.id)
          : await retryRingsOperation(operation.id);
      setBusyId(null);
      if (result.error) {
        setError(result.error);
      }
      await onChanged();
    },
    [onChanged]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.recovery.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.recovery.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <Callout variant="danger">{error}</Callout> : null}
        {waiting.length === 0 ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.recovery.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardHeliusRings.activity.operation")}</TableHead>
                <TableHead>{t("DashboardHeliusRings.activity.created")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {waiting.map((operation) => {
                const awaitingApproval = operation.state === "approval_required";
                const busy = busyId === operation.id;
                return (
                  <TableRow key={operation.id}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        {t(`DashboardHeliusRings.activity.opType_${operation.opType}`)}
                        <Badge variant={awaitingApproval ? "warning" : "danger"}>
                          {t(`DashboardHeliusRings.activity.state_${operation.state}`)}
                        </Badge>
                      </span>
                    </TableCell>
                    <TableCell>{formatWhen(operation.createdAt, locale)}</TableCell>
                    <TableCell>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleAction(operation)}
                      >
                        {awaitingApproval
                          ? t(
                              busy
                                ? "DashboardHeliusRings.recovery.executing"
                                : "DashboardHeliusRings.recovery.execute"
                            )
                          : t(
                              busy
                                ? "DashboardHeliusRings.recovery.retrying"
                                : "DashboardHeliusRings.recovery.retry"
                            )}
                      </Button>
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
