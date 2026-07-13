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
import { useLocale, useTranslations } from "@/i18n/provider";
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

function formatDate(
  value: string | null,
  locale: string,
  t: ReturnType<typeof useTranslations>
): string {
  if (!value) return t("DashboardCustody.never");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function formatRole(role: ApiKeyRole, t: ReturnType<typeof useTranslations>): string {
  if (role === "api_admin") return t("DashboardCustody.admin");
  if (role === "api_readonly") return t("DashboardCustody.readOnly");
  return t("DashboardCustody.developer");
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
  walletLabelById: Map<string, string>,
  t: ReturnType<typeof useTranslations>
): { label: string; title: string } {
  if (key.walletScope === "all") {
    return { label: t("DashboardCustody.allWallets"), title: t("DashboardCustody.allWallets") };
  }

  const walletIds =
    key.walletBindings.length > 0
      ? key.walletBindings.map((binding) => binding.walletId)
      : key.signingWalletIds;
  const walletNames = walletIds.map((walletId) => walletLabelById.get(walletId) ?? walletId);

  if (walletNames.length === 0) {
    return {
      label: t("DashboardCustody.selectedWallets"),
      title: t("DashboardCustody.selectedWallets"),
    };
  }

  return {
    label: t("DashboardCustody.selected", { count: walletNames.length }),
    title: walletNames.join(", "),
  };
}

function formatPolicyBinding(
  binding: ApiKeyWalletPolicyBindingSummary,
  t: ReturnType<typeof useTranslations>
): string {
  if (binding.apiKeyControlProfileId) {
    const revision = binding.apiKeyControlProfileRevisionId
      ? t("DashboardCustody.revision", { id: shortId(binding.apiKeyControlProfileRevisionId) })
      : "";
    return t("DashboardCustody.apiProfile", {
      id: shortId(binding.apiKeyControlProfileId),
      revision,
    });
  }

  if (binding.walletControlProfileId) {
    const revision = binding.walletControlProfileRevisionId
      ? t("DashboardCustody.revision", { id: shortId(binding.walletControlProfileRevisionId) })
      : "";
    return t("DashboardCustody.walletProfile", {
      id: shortId(binding.walletControlProfileId),
      revision,
    });
  }

  return t("DashboardCustody.policyBinding");
}

function getPolicySummary(
  key: ApiKeyRecord,
  walletLabelById: Map<string, string>,
  t: ReturnType<typeof useTranslations>
): { label: string; title: string } {
  if (key.policyBindings.length === 0) {
    return {
      label: t("DashboardCustody.noApiKeyPolicy"),
      title: t("DashboardCustody.noAdditionalApiKeyPolicy"),
    };
  }

  const policyLabels = key.policyBindings.map((binding) => {
    const walletLabel =
      binding.bindingScope === "all"
        ? t("DashboardCustody.allWallets")
        : (walletLabelById.get(binding.walletId ?? "") ??
          binding.walletId ??
          t("DashboardCustody.selectedWallet"));
    return `${walletLabel}: ${formatPolicyBinding(binding, t)}`;
  });

  return {
    label:
      key.policyBindings.length === 1
        ? t("DashboardCustody.policyBindingCount", { count: key.policyBindings.length })
        : t("DashboardCustody.policyBindingsCount", { count: key.policyBindings.length }),
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
  const t = useTranslations();
  const walletSummary = getWalletNames(apiKey, walletLabelById, t);
  const policySummary = getPolicySummary(apiKey, walletLabelById, t);

  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-[#1c1c1d]">
        {t("DashboardCustody.roleAccess", { role: formatRole(apiKey.role, t) })}
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
  const t = useTranslations();
  const locale = useLocale();
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
    return (
      <p className="text-sm text-[rgba(28,28,29,0.72)]">{t("DashboardCustody.noApiKeysFound")}</p>
    );
  }

  return (
    <Table className="[&_table]:w-full [&_table]:min-w-0 [&_table]:table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[24%] @4xl/api-keys-table:w-[17%]">
            {t("DashboardCustody.name")}
          </TableHead>
          <TableHead className={`${PREFIX_COLUMN_CLASS} w-[10%]`}>
            {t("DashboardCustody.prefix")}
          </TableHead>
          <TableHead className="w-[48%] @4xl/api-keys-table:w-[27%]">
            {t("DashboardCustody.access")}
          </TableHead>
          <TableHead className={`${STATUS_COLUMN_CLASS} w-[8%]`}>
            {t("DashboardCustody.status")}
          </TableHead>
          <TableHead className={`${LAST_USED_COLUMN_CLASS} w-[9%]`}>
            {t("DashboardCustody.lastUsed")}
          </TableHead>
          <TableHead className={`${EXPIRES_COLUMN_CLASS} w-[9%]`}>
            {t("DashboardCustody.expires")}
          </TableHead>
          <TableHead className={`${CREATED_COLUMN_CLASS} w-[9%]`}>
            {t("DashboardCustody.created")}
          </TableHead>
          <TableHead className="w-[18%] @4xl/api-keys-table:w-[14%] @7xl/api-keys-table:w-[11%]">
            {canManageApiKeys ? t("DashboardCustody.actions") : ""}
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
                {formatDate(key.lastUsedAt, locale, t)}
              </TableCell>
              <TableCell className={`${EXPIRES_COLUMN_CLASS} text-xs text-[rgba(28,28,29,0.72)]`}>
                {formatDate(key.expiresAt, locale, t)}
              </TableCell>
              <TableCell className={`${CREATED_COLUMN_CLASS} text-xs text-[rgba(28,28,29,0.72)]`}>
                {formatDate(key.createdAt, locale, t)}
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
