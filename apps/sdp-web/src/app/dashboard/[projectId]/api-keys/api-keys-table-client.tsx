"use client";

import type { Action } from "@sdp/types/actions";
import type {
  ApiKeyEnvironment,
  ApiKeyStatus,
  ApiKeyWalletBinding,
  ApiKeyWalletScope,
} from "@sdp/types/api-keys";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import { ListEmptyState } from "@sdp/ui/list-empty-state";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { ApiKeyActionsMenu } from "./api-key-actions-menu";
import { grantSummaryLines, grantsSummaryLabel } from "./api-key-grant-labels";

const PREFIX_COLUMN_CLASS = "hidden @4xl/api-keys-table:table-cell";
const STATUS_COLUMN_CLASS = "hidden @5xl/api-keys-table:table-cell";
const LAST_USED_COLUMN_CLASS = "hidden @6xl/api-keys-table:table-cell";
const EXPIRES_COLUMN_CLASS = "hidden @7xl/api-keys-table:table-cell";
const CREATED_COLUMN_CLASS = "hidden @7xl/api-keys-table:table-cell";

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  grants: Action[];
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: ApiKeyWalletBinding[];
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

function formatWalletLabel(wallet: PaymentsDashboardWallet): string {
  return wallet.label?.trim() || wallet.walletId;
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

function AccessSummary({
  apiKey,
  walletLabelById,
}: {
  apiKey: ApiKeyRecord;
  walletLabelById: Map<string, string>;
}) {
  const t = useTranslations();
  const walletSummary = getWalletNames(apiKey, walletLabelById, t);
  const grantLines = grantSummaryLines(apiKey.grants, t);

  return (
    <div className="min-w-0">
      <p
        className="truncate text-sm font-medium text-primary"
        title={grantLines.join("\n") || undefined}
      >
        {grantLines.length === 1 ? grantLines[0] : grantsSummaryLabel(apiKey.grants, t)}
      </p>
      <p className="mt-1 truncate text-xs text-secondary" title={walletSummary.title}>
        {walletSummary.label}
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
  const router = useRouter();
  const href = useProjectHref();
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
      <ListEmptyState
        icon={<KeyRoundIcon className="size-5" />}
        message={t("DashboardCustody.noApiKeysFound")}
        action={
          canManageApiKeys ? (
            <Button asChild size="sm">
              <Link href={href("/dashboard/api-keys/new")}>
                <PlusIcon className="size-4" />
                {t("DashboardCustody.createNewApiKey")}
              </Link>
            </Button>
          ) : null
        }
      />
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
                <span className="mt-1 block truncate text-[11px] font-normal text-tertiary">
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
              <TableCell className={`${LAST_USED_COLUMN_CLASS} text-xs text-secondary`}>
                {formatDate(key.lastUsedAt, locale, t)}
              </TableCell>
              <TableCell className={`${EXPIRES_COLUMN_CLASS} text-xs text-secondary`}>
                {formatDate(key.expiresAt, locale, t)}
              </TableCell>
              <TableCell className={`${CREATED_COLUMN_CLASS} text-xs text-secondary`}>
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
                      router.refresh();
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
