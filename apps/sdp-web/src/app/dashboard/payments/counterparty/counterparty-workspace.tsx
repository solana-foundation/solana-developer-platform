"use client";

import type { Counterparty } from "@sdp/types";
import { PlusIcon, UsersIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { DashboardWorkspaceTabShell } from "@/components/dashboard-workspace-tab-shell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { toTitleCase } from "../../activity-format-utils";
import type { CounterpartyPlaygroundView } from "./counterparty-playground-config";

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
  apiKeys: CounterpartyApiKeyOption[];
  apiBaseUrl: string | null;
}

export function CounterpartyWorkspace({
  initialCounterparties,
  apiKeys,
  apiBaseUrl,
}: CounterpartyWorkspaceProps) {
  const router = useRouter();
  const { counterpartyTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } =
    useDashboardWorkspace();
  const [counterparties, setCounterparties] = useState(initialCounterparties);
  const isPlaygroundTab = counterpartyTab === "playground";

  useEffect(() => {
    setCounterparties(initialCounterparties);
  }, [initialCounterparties]);

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

  return (
    <DashboardWorkspaceTabShell
      isPlaygroundTab={isPlaygroundTab}
      overviewClassName="space-y-6"
      overviewKey="counterparty-overview-tab"
      playgroundKey="counterparty-playground-tab"
      overview={
        <Card className="flex flex-1 flex-col">
          <CardHeader>
            <CardTitle>Directory</CardTitle>
            <CardDescription>
              Registered individuals and businesses in your workspace.
            </CardDescription>
            {counterparties.length > 0 && (
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
          <CardContent className="flex flex-1 flex-col">
            {counterparties.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border-medium py-16 text-center">
                <UsersIcon className="h-10 w-10 text-text-extra-low" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-text-extra-high">No counterparties yet</p>
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
              <Table className="[&_table]:table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[22%]">Display name</TableHead>
                    <TableHead className="w-[11%]">Type</TableHead>
                    <TableHead className="w-[22%]">Email</TableHead>
                    <TableHead className="w-[16%]">External ID</TableHead>
                    <TableHead className="w-[14%]">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {counterparties.map((cp) => (
                    <TableRow key={cp.id}>
                      <TableCell className="font-medium">
                        <span className="block truncate">{cp.displayName}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="block truncate">{toTitleCase(cp.entityType)}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="block truncate">{cp.email}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <span className="block truncate">{cp.externalId ?? "—"}</span>
                      </TableCell>
                      <TableCell className="text-xs text-text-medium">
                        {new Date(cp.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "2-digit",
                          year: "numeric",
                        })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
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
  );
}
