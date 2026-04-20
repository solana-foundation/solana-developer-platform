"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiKeyActionsMenu } from "./api-key-actions-menu";

type ApiKeyRole = "api_admin" | "api_developer" | "api_readonly";
type ApiKeyEnvironment = "sandbox" | "production";
type ApiKeyStatus = "active" | "revoked" | "expired" | "deactivated";

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatRole(role: ApiKeyRole): string {
  if (role === "api_admin") return "Admin";
  if (role === "api_readonly") return "Read only";
  return "Developer";
}

export function ApiKeysTableClient({
  initialApiKeys,
  canManageApiKeys,
}: {
  initialApiKeys: ApiKeyRecord[];
  canManageApiKeys: boolean;
}) {
  const [apiKeys, setApiKeys] = useState(initialApiKeys);

  useEffect(() => {
    setApiKeys(initialApiKeys);
  }, [initialApiKeys]);

  const sortedApiKeys = useMemo(() => {
    return [...apiKeys].sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [apiKeys]);

  if (sortedApiKeys.length === 0) {
    return <p className="text-sm text-[rgba(28,28,29,0.72)]">No API keys found.</p>;
  }

  return (
    <Table className="[&_table]:table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[14%]">Name</TableHead>
          <TableHead className="w-[14%]">Prefix</TableHead>
          <TableHead className="w-[10%]">Role</TableHead>
          <TableHead className="w-[8%]">Env</TableHead>
          <TableHead className="w-[10%]">Status</TableHead>
          <TableHead className="w-[11%]">Last used</TableHead>
          <TableHead className="w-[11%]">Expires</TableHead>
          <TableHead className="w-[11%]">Created</TableHead>
          <TableHead className="w-[21%] text-right">{canManageApiKeys ? "Actions" : ""}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedApiKeys.map((key) => {
          const canRotate = key.status === "active";

          return (
            <TableRow key={key.id}>
              <TableCell className="font-medium">
                <span className="block truncate">{key.name}</span>
              </TableCell>
              <TableCell className="font-mono text-xs">
                <span className="block truncate">{key.keyPrefix}</span>
              </TableCell>
              <TableCell className="text-xs">
                <span className="block truncate">{formatRole(key.role)}</span>
              </TableCell>
              <TableCell className="text-xs">
                <span className="block truncate">{key.environment}</span>
              </TableCell>
              <TableCell className="text-xs">
                <span className="block truncate">{key.status}</span>
              </TableCell>
              <TableCell className="text-xs text-[rgba(28,28,29,0.72)]">
                {formatDate(key.lastUsedAt)}
              </TableCell>
              <TableCell className="text-xs text-[rgba(28,28,29,0.72)]">
                {formatDate(key.expiresAt)}
              </TableCell>
              <TableCell className="text-xs text-[rgba(28,28,29,0.72)]">
                {formatDate(key.createdAt)}
              </TableCell>
              <TableCell className="text-right">
                {canManageApiKeys ? (
                  <ApiKeyActionsMenu
                    keyId={key.id}
                    keyName={key.name}
                    canRotate={canRotate}
                    onDeleted={() => {
                      setApiKeys((previous) => previous.filter((item) => item.id !== key.id));
                    }}
                  />
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
