"use client";

import type { Counterparty } from "@sdp/types";
import { MoreHorizontalIcon, PlusIcon, Trash2Icon, UserIcon, UsersIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import type { CounterpartyPlaygroundView } from "./counterparty-playground-config";
import { DeleteCounterpartyDialog } from "./delete-counterparty-dialog";
import { useCounterpartyDirectory } from "./use-counterparty-directory";

const CounterpartyPlayground = dynamic(
  () => import("./counterparty-playground").then((module) => module.CounterpartyPlayground),
  { loading: () => <ApiPlaygroundShellSkeleton /> }
);

interface CounterpartyApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface CounterpartyWorkspaceProps {
  initialCounterparties: Counterparty[];
  initialTotal: number;
  apiKeys: CounterpartyApiKeyOption[];
  apiBaseUrl: string | null;
}

export function CounterpartyWorkspace({
  initialCounterparties,
  initialTotal,
  apiKeys,
  apiBaseUrl,
}: CounterpartyWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useDashboardRouter();
  const { counterpartyTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } =
    useDashboardWorkspace();
  const isPlaygroundTab = counterpartyTab === "playground";

  const {
    page,
    setPage,
    counterparties,
    total,
    pageCount,
    summary: pageSummary,
    removeOptimistic,
  } = useCounterpartyDirectory(initialCounterparties, initialTotal);

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

  useEffect(() => {
    if (isPlaygroundTab) return;

    const preload = () => {
      void import("./counterparty-playground");
    };

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preload);
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(preload, 600);
    return () => globalThis.clearTimeout(timeoutId);
  }, [isPlaygroundTab]);

  const selectedPlaygroundApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId) ?? null,
    [apiKeys, selectedPlaygroundApiKeyId]
  );

  const playgroundApiKeyValue = useMemo(() => {
    if (!selectedPlaygroundApiKey) return "";
    return (
      getStoredApiKeySecret({
        apiKeyId: selectedPlaygroundApiKey.id,
        keyPrefix: selectedPlaygroundApiKey.keyPrefix,
      }) ?? ""
    );
  }, [selectedPlaygroundApiKey]);

  const playgroundCounterparties = useMemo<CounterpartyPlaygroundView[]>(
    () => counterparties.map((cp) => ({ id: cp.id, displayName: cp.displayName })),
    [counterparties]
  );

  const [pendingDelete, setPendingDelete] = useState<Counterparty | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;

    // Optimistically drop the row, then reconcile with the server below.
    removeOptimistic(target.id);
    setPendingDelete(null);

    const result = await dashboardFetch(
      `/api/dashboard/counterparty/${encodeURIComponent(target.id)}`,
      { method: "DELETE" }
    );
    if (!result.ok) {
      toast.error(result.error, { position: "bottom-right" });
      router.refresh(); // restore the optimistically-removed row
      return;
    }
    toast.success(t("DashboardPayments.counterparty.deleted", { name: target.displayName }), {
      position: "bottom-right",
    });
    router.refresh();
  }

  return (
    <>
      <DashboardWorkspaceTabShell
        isPlaygroundTab={isPlaygroundTab}
        overviewClassName="flex min-h-0 flex-col overflow-hidden"
        overviewKey="counterparty-overview-tab"
        playgroundKey="counterparty-playground-tab"
        overview={
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader>
              <CardTitle>{t("DashboardPayments.counterparty.directory")}</CardTitle>
              <CardDescription>
                {t("DashboardPayments.counterparty.directoryDescription")}
              </CardDescription>
              {total > 0 && (
                <CardAction>
                  <Button
                    type="button"
                    iconLeft={<PlusIcon />}
                    onClick={() => router.push("/dashboard/payments/counterparty/create")}
                  >
                    {t("DashboardPayments.counterparty.create")}
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {total === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border-strong py-16 text-center">
                  <UsersIcon className="h-10 w-10 text-muted" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-primary">
                      {t("DashboardPayments.counterparty.noCounterparties")}
                    </p>
                    <p className="text-sm text-tertiary">
                      {t("DashboardPayments.counterparty.noCounterpartiesDescription")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    iconLeft={<PlusIcon />}
                    onClick={() => router.push("/dashboard/payments/counterparty/create")}
                  >
                    {t("DashboardPayments.counterparty.create")}
                  </Button>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <Table className="[&_table]:table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[30%]">
                          {t("DashboardPayments.counterparty.displayName")}
                        </TableHead>
                        <TableHead className="w-[12%]">
                          {t("DashboardPayments.counterparty.type")}
                        </TableHead>
                        <TableHead className="w-[24%]">
                          {t("DashboardPayments.counterparty.email")}
                        </TableHead>
                        <TableHead className="w-[16%]">
                          {t("DashboardPayments.counterparty.externalId")}
                        </TableHead>
                        <TableHead className="w-[18%]">
                          {t("DashboardPayments.recurring.created")}
                        </TableHead>
                        <TableHead className="w-[56px]" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {counterparties.map((cp) => (
                        <TableRow key={cp.id}>
                          <TableCell className="font-medium">
                            <span className="block truncate">{cp.displayName}</span>
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className="block truncate">
                              {cp.entityType === "individual"
                                ? t("DashboardPayments.counterparty.individual")
                                : t("DashboardPayments.counterparty.business")}
                            </span>
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className="block truncate">{cp.email}</span>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            <span className="block truncate">{cp.externalId ?? "—"}</span>
                          </TableCell>
                          <TableCell className="text-sm text-secondary">
                            {new Date(cp.createdAt).toLocaleDateString(locale, {
                              month: "short",
                              day: "2-digit",
                              year: "numeric",
                            })}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t(
                                    "DashboardPayments.counterparty.counterpartyActions"
                                  )}
                                >
                                  <MoreHorizontalIcon />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent>
                                <DropdownMenuItem
                                  className="text-xs [&_svg]:size-3.5"
                                  onSelect={() =>
                                    router.push(`/dashboard/payments/counterparty/${cp.id}`)
                                  }
                                >
                                  <UserIcon />
                                  {t("DashboardPayments.counterparty.manageCounterparty")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-xs text-error focus:text-error [&_svg]:size-3.5"
                                  onSelect={() => setPendingDelete(cp)}
                                >
                                  <Trash2Icon />
                                  {t("DashboardPayments.counterparty.deleteCounterparty")}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
            {total > 0 && (
              <CardFooter className="shrink-0 border-t border-border-default">
                <ArrowPagination
                  className="w-full"
                  page={page}
                  pageCount={pageCount}
                  onPageChange={setPage}
                  summary={pageSummary}
                />
              </CardFooter>
            )}
          </Card>
        }
        playground={
          <CounterpartyPlayground
            apiBaseUrl={apiBaseUrl}
            apiKeyValue={playgroundApiKeyValue}
            hasActiveApiKeys={apiKeys.length > 0}
            counterparties={playgroundCounterparties}
          />
        }
      />
      <DeleteCounterpartyDialog
        isOpen={pendingDelete !== null}
        displayName={pendingDelete?.displayName ?? null}
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}
