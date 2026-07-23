"use client";

import { ASSET_AUDIT_ACTIONS, ASSET_AUDIT_ACTOR_TYPES, ASSET_AUDIT_STATUSES } from "@sdp/types";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { formatDateTime } from "../../token-management-workspace.utils";
import { fetchAssetAuditHistory } from "../asset-audit.data";
import {
  auditActionIcon,
  auditActionLabel,
  auditActorBadgeClass,
  auditActorTypeLabel,
  auditStatusBadgeClass,
} from "../asset-audit-presentation";

const PAGE_STEP = 50;
// Sentinel select value for the "no filter" option (Select treats null/"" as the
// empty placeholder, so the reset option needs a real value). Shared across the
// action/status/type filters — each Select is independent.
const ALL = "__all__";

export function ActivityTab({ tokenId }: { tokenId: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const [action, setAction] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [actorType, setActorType] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_STEP);

  const { data, error, isLoading } = usePersistedDashboardSWR(
    [
      "asset-audit",
      tokenId,
      action ?? "all",
      status ?? "all",
      actorType ?? "all",
      pageSize,
    ] as const,
    ([, id, act, st, ty, size]) =>
      fetchAssetAuditHistory(id, {
        action: act === "all" ? null : act,
        status: st === "all" ? null : st,
        actorType: ty === "all" ? null : ty,
        pageSize: Number(size),
      }),
    { revalidateOnFocus: true, revalidateIfStale: true },
    {
      key: `token.${tokenId}.audit.${action ?? "all"}.${status ?? "all"}.${actorType ?? "all"}.${pageSize}`,
      ttlMs: 30_000,
    }
  );

  const events = data?.events ?? [];
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : t("DashboardIssuance.activity.error")
    : null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t("DashboardIssuance.activity.title")}</CardTitle>
        <CardDescription>{t("DashboardIssuance.activity.description")}</CardDescription>
        <CardAction className="flex flex-wrap items-center justify-end gap-2">
          <div className="w-40">
            <Select
              ariaLabel={t("DashboardIssuance.activity.filterLabel")}
              value={action ?? ALL}
              onValueChange={(value) => {
                setAction(value === ALL ? null : value);
                setPageSize(PAGE_STEP);
              }}
            >
              <SelectItem value={ALL}>{t("DashboardIssuance.activity.filterAll")}</SelectItem>
              {ASSET_AUDIT_ACTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {auditActionLabel(value)}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Select
              ariaLabel={t("DashboardIssuance.activity.columnStatus")}
              value={status ?? ALL}
              onValueChange={(value) => {
                setStatus(value === ALL ? null : value);
                setPageSize(PAGE_STEP);
              }}
            >
              <SelectItem value={ALL}>
                {t("DashboardIssuance.activity.filterAllStatuses")}
              </SelectItem>
              {ASSET_AUDIT_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "failure"
                    ? t("DashboardIssuance.activity.statusFailure")
                    : t("DashboardIssuance.activity.statusSuccess")}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <Select
              ariaLabel={t("DashboardIssuance.activity.columnActorType")}
              value={actorType ?? ALL}
              onValueChange={(value) => {
                setActorType(value === ALL ? null : value);
                setPageSize(PAGE_STEP);
              }}
            >
              <SelectItem value={ALL}>{t("DashboardIssuance.activity.filterAllTypes")}</SelectItem>
              {ASSET_AUDIT_ACTOR_TYPES.map((value) => (
                <SelectItem key={value} value={value}>
                  {auditActorTypeLabel(value, t)}
                </SelectItem>
              ))}
            </Select>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading && events.length === 0 ? (
          <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-border-subtle bg-fill-subtle px-6 py-10">
            <div className="flex items-center gap-3 text-sm text-secondary">
              <Loader2 className="size-4 animate-spin" />
              <span>{t("DashboardIssuance.activity.loading")}</span>
            </div>
          </div>
        ) : errorMessage ? (
          <p className="text-sm text-error">{errorMessage}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-secondary">{t("DashboardIssuance.activity.empty")}</p>
        ) : (
          <div className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead align="left">{t("DashboardIssuance.activity.columnAction")}</TableHead>
                  <TableHead align="left">{t("DashboardIssuance.activity.columnActor")}</TableHead>
                  <TableHead align="left">
                    {t("DashboardIssuance.activity.columnActorType")}
                  </TableHead>
                  <TableHead align="left">{t("DashboardIssuance.activity.columnStatus")}</TableHead>
                  <TableHead align="right">{t("DashboardIssuance.activity.columnTime")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => {
                  const ActionIcon = auditActionIcon(event.action);
                  return (
                    <TableRow key={event.id} data-testid={`audit-row-${event.id}`}>
                      <TableCell align="left">
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-fill-subtle px-2 py-1 text-xs font-medium text-secondary">
                          <ActionIcon className="h-3.5 w-3.5 shrink-0" />
                          {auditActionLabel(event.action)}
                        </span>
                      </TableCell>
                      <TableCell align="left" className="text-sm text-secondary">
                        {event.actorLabel}
                      </TableCell>
                      <TableCell align="left">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${auditActorBadgeClass(
                            event.actorType
                          )}`}
                        >
                          {auditActorTypeLabel(event.actorType, t)}
                        </span>
                      </TableCell>
                      <TableCell align="left">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${auditStatusBadgeClass(
                            event.status
                          )}`}
                        >
                          {event.status === "failure"
                            ? t("DashboardIssuance.activity.statusFailure")
                            : t("DashboardIssuance.activity.statusSuccess")}
                        </span>
                      </TableCell>
                      <TableCell align="right" numeric className="text-sm text-secondary">
                        {formatDateTime(event.createdAt, locale)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {data?.hasMore ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isLoading}
                onClick={() => setPageSize((size) => size + PAGE_STEP)}
              >
                {t("DashboardIssuance.activity.loadMore")}
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
