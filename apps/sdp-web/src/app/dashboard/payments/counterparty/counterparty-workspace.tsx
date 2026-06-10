"use client";

import type { Counterparty } from "@sdp/types";
import { MoreHorizontalIcon, PlusIcon, Trash2Icon, UserIcon, UsersIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
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
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { toTitleCase } from "../../activity-format-utils";
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
  const router = useRouter();
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
    toast.success(`${target.displayName} deleted`, { position: "bottom-right" });
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
              <CardTitle>Directory</CardTitle>
              <CardDescription>
                Registered individuals and businesses in your workspace.
              </CardDescription>
              {total > 0 && (
                <CardAction>
                  <Button
                    type="button"
                    iconLeft={<PlusIcon />}
                    onClick={() => router.push("/dashboard/payments/counterparty/create")}
                  >
                    Create
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col">
              {total === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border-medium py-16 text-center">
                  <UsersIcon className="h-10 w-10 text-text-extra-low" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-text-extra-high">
                      No counterparties yet
                    </p>
                    <p className="text-sm text-text-low">
                      Add your first individual or business to get started.
                    </p>
                  </div>
                  <Button
                    type="button"
                    iconLeft={<PlusIcon />}
                    onClick={() => router.push("/dashboard/payments/counterparty/create")}
                  >
                    Create
                  </Button>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <Table className="[&_table]:table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[30%]">Display name</TableHead>
                        <TableHead className="w-[12%]">Type</TableHead>
                        <TableHead className="w-[24%]">Email</TableHead>
                        <TableHead className="w-[16%]">External ID</TableHead>
                        <TableHead className="w-[18%]">Created</TableHead>
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
                            <span className="block truncate">{toTitleCase(cp.entityType)}</span>
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className="block truncate">{cp.email}</span>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            <span className="block truncate">{cp.externalId ?? "—"}</span>
                          </TableCell>
                          <TableCell className="text-sm text-text-medium">
                            {new Date(cp.createdAt).toLocaleDateString("en-US", {
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
                                  aria-label="Counterparty actions"
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
                                  Manage Counterparty
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-xs text-status-error-text focus:text-status-error-text [&_svg]:size-3.5"
                                  onSelect={() => setPendingDelete(cp)}
                                >
                                  <Trash2Icon />
                                  Delete Counterparty
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
              <CardFooter className="shrink-0 border-t border-border-light">
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
