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
import { type RingsOperationSummary, retryRingsOperation } from "./helius-rings.data";

/**
 * Failed operations with a retry action. Retryability is enforced server-side
 * (non-retryable failures and exhausted chains reject); the card just relays
 * the verdict.
 */
export function RecoveryCard({
  operations,
  onRetried,
}: {
  operations: RingsOperationSummary[];
  onRetried: () => Promise<void>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const failed = operations.filter((operation) => operation.state === "failed");

  const handleRetry = useCallback(
    async (operationId: string) => {
      setRetryingId(operationId);
      setError(null);
      const result = await retryRingsOperation(operationId);
      setRetryingId(null);
      if (result.error) {
        setError(result.error);
      }
      await onRetried();
    },
    [onRetried]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("DashboardHeliusRings.recovery.title")}</CardTitle>
        <CardDescription>{t("DashboardHeliusRings.recovery.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <Callout variant="danger">{error}</Callout> : null}
        {failed.length === 0 ? (
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
              {failed.map((operation) => (
                <TableRow key={operation.id}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {t(`DashboardHeliusRings.activity.opType_${operation.opType}`)}
                      <Badge variant="danger">
                        {t("DashboardHeliusRings.activity.state_failed")}
                      </Badge>
                    </span>
                  </TableCell>
                  <TableCell>
                    {new Date(operation.createdAt).toLocaleString(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={retryingId === operation.id}
                      onClick={() => void handleRetry(operation.id)}
                    >
                      {retryingId === operation.id
                        ? t("DashboardHeliusRings.recovery.retrying")
                        : t("DashboardHeliusRings.recovery.retry")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
