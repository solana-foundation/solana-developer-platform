"use client";

import type {
  ApiKeyEnvironment,
  ApiKeyRole,
  ApiKeyStatus,
  ApiKeyWalletBinding,
  ApiKeyWalletPolicyBindingSummary,
  ApiKeyWalletScope,
  PaymentsDashboardWallet,
} from "@sdp/types";
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

const PREFIX_COLUMN_CLASS = "hidden @4xl/api-keys-table:table-cell";
const STATUS_COLUMN_CLASS = "hidden @5xl/api-keys-table:table-cell";
const LAST_USED_COLUMN_CLASS = "hidden @6xl/api-keys-table:table-cell";
const EXPIRES_COLUMN_CLASS = "hidden @7xl/api-keys-table:table-cell";
const CREATED_COLUMN_CLASS = "hidden @7xl/api-keys-table:table-cell";

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: ApiKeyWalletBinding[];
  policyBindings: ApiKeyWalletPolicyBindingSummary[];
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

function formatWalletLabel(wallet: PaymentsDashboardWallet): string {
  return wallet.label?.trim() || wallet.walletId;
}

function shortId(value: string | null): string {
  if (!value) return "";
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function getWalletNames(
  key: ApiKeyRecord,
  walletLabelById: Map<string, string>
): { label: string; title: string } {
  if (key.walletScope === "all") {
    return { label: "All wallets", title: "All wallets" };
  }

  const walletIds =
    key.walletBindings.length > 0
      ? key.walletBindings.map((binding) => binding.walletId)
      : key.signingWalletIds;
  const walletNames = walletIds.map((walletId) => walletLabelById.get(walletId) ?? walletId);

  if (walletNames.length === 0) {
    return { label: "Selected wallets", title: "Selected wallets" };
  }

  return {
    label: `${walletNames.length} selected`,
    title: walletNames.join(", "),
  };
}

function formatPolicyBinding(binding: ApiKeyWalletPolicyBindingSummary): string {
  if (binding.apiKeyControlProfileId) {
    const revision = binding.apiKeyControlProfileRevisionId
      ? ` rev ${shortId(binding.apiKeyControlProfileRevisionId)}`
      : "";
    return `API profile ${shortId(binding.apiKeyControlProfileId)}${revision}`;
  }

  if (binding.walletControlProfileId) {
    const revision = binding.walletControlProfileRevisionId
      ? ` rev ${shortId(binding.walletControlProfileRevisionId)}`
      : "";
    return `Wallet profile ${shortId(binding.walletControlProfileId)}${revision}`;
  }

  return "Policy binding";
}

function getPolicySummary(
  key: ApiKeyRecord,
  walletLabelById: Map<string, string>
): { label: string; title: string } {
  if (key.policyBindings.length === 0) {
    return {
      label: "No API-key policy",
      title: "No additional API-key policy is attached.",
    };
  }

  const policyLabels = key.policyBindings.map((binding) => {
    const walletLabel =
      binding.bindingScope === "all"
        ? "All wallets"
        : (walletLabelById.get(binding.walletId ?? "") ?? binding.walletId ?? "Selected wallet");
    return `${walletLabel}: ${formatPolicyBinding(binding)}`;
  });

  return {
    label: `${key.policyBindings.length} policy ${key.policyBindings.length === 1 ? "binding" : "bindings"}`,
    title: policyLabels.join("; "),
  };
}

function AccessSummary({
  apiKey,
  walletLabelById,
}: {
  apiKey: ApiKeyRecord;
  walletLabelById: Map<string, string>;
}) {
  const walletSummary = getWalletNames(apiKey, walletLabelById);
  const policySummary = getPolicySummary(apiKey, walletLabelById);

  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-[#1c1c1d]">
        {formatRole(apiKey.role)} access
      </p>
      <p
        className="mt-1 truncate text-xs text-[rgba(28,28,29,0.62)]"
        title={`${walletSummary.title} · ${policySummary.title}`}
      >
        {walletSummary.label} · {policySummary.label}
      </p>
    </div>
  );
}

export function ApiKeysTableClient({
  initialApiKeys,
  canManageApiKeys,
  wallets,
}: {
  initialApiKeys: ApiKeyRecord[];
  canManageApiKeys: boolean;
  wallets: PaymentsDashboardWallet[];
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

  const walletLabelById = useMemo(() => {
    return new Map(wallets.map((wallet) => [wallet.walletId, formatWalletLabel(wallet)]));
  }, [wallets]);

  if (sortedApiKeys.length === 0) {
    return <p className="text-sm text-[rgba(28,28,29,0.72)]">No API keys found.</p>;
  }

  return (
    <Table className="[&_table]:w-full [&_table]:min-w-0 [&_table]:table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[24%] @4xl/api-keys-table:w-[17%]">Name</TableHead>
          <TableHead className={`${PREFIX_COLUMN_CLASS} w-[10%]`}>Prefix</TableHead>
          <TableHead className="w-[48%] @4xl/api-keys-table:w-[27%]">Access</TableHead>
          <TableHead className={`${STATUS_COLUMN_CLASS} w-[8%]`}>Status</TableHead>
          <TableHead className={`${LAST_USED_COLUMN_CLASS} w-[9%]`}>Last used</TableHead>
          <TableHead className={`${EXPIRES_COLUMN_CLASS} w-[9%]`}>Expires</TableHead>
          <TableHead className={`${CREATED_COLUMN_CLASS} w-[9%]`}>Created</TableHead>
          <TableHead className="w-[18%] @4xl/api-keys-table:w-[14%] @7xl/api-keys-table:w-[11%]">
            {canManageApiKeys ? "Actions" : ""}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedApiKeys.map((key) => {
          const canRotate = key.status === "active";

          return (
            <TableRow key={key.id}>
              <TableCell className="font-medium">
                <span className="block truncate">{key.name}</span>
                <span className="mt-1 block truncate text-[11px] font-normal text-[rgba(28,28,29,0.58)]">
                  {key.environment}
                  <span className="@5xl/api-keys-table:hidden"> · {key.status}</span>
                  <span className="@4xl/api-keys-table:hidden"> · {key.keyPrefix}</span>
                </span>
              </TableCell>
              <TableCell className={`${PREFIX_COLUMN_CLASS} font-mono text-xs`}>
                <span className="block truncate">{key.keyPrefix}</span>
              </TableCell>
              <TableCell className="text-xs">
                <AccessSummary apiKey={key} walletLabelById={walletLabelById} />
              </TableCell>
              <TableCell className={`${STATUS_COLUMN_CLASS} text-xs`}>
                <span className="block truncate">{key.status}</span>
              </TableCell>
              <TableCell className={`${LAST_USED_COLUMN_CLASS} text-xs text-[rgba(28,28,29,0.72)]`}>
                {formatDate(key.lastUsedAt)}
              </TableCell>
              <TableCell className={`${EXPIRES_COLUMN_CLASS} text-xs text-[rgba(28,28,29,0.72)]`}>
                {formatDate(key.expiresAt)}
              </TableCell>
              <TableCell className={`${CREATED_COLUMN_CLASS} text-xs text-[rgba(28,28,29,0.72)]`}>
                {formatDate(key.createdAt)}
              </TableCell>
              <TableCell>
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
