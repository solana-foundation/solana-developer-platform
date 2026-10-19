"use client";

import type {
  CounterpartyProviderAccount,
  CounterpartyProviderCustomerLink,
  PersistedRampProviderId,
} from "@sdp/types";
import { WalletMetadataCopyButton } from "@/app/dashboard/[projectId]/custody/wallet-address-copy-button";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import { getRampProviderLabel } from "@/lib/ramps";
import { toTitleCase } from "../../activity-format-utils";
import { formatDisplayAmount } from "../payments-overview.utils";

const PROVIDER_ACCOUNT_STATUS_TONE: ReadonlyMap<string, StatusTone> = new Map([
  ["active", "positive"],
  ["completed", "positive"],
  ["ready", "positive"],
  ["verified", "positive"],
  ["provisioned_funding_wallet", "positive"],
  ["archived", "critical"],
  ["failed", "critical"],
  ["rejected", "critical"],
]);

/** The table's columns, left to right, as the message keys of their headers. */
const PROVIDER_ACCOUNT_COLUMN_KEYS = [
  "DashboardPayments.counterparty.detail.provider",
  "DashboardPayments.counterparty.detail.corridor",
  "DashboardPayments.counterparty.detail.rail",
  "DashboardPayments.counterparty.detail.account",
  "DashboardPayments.counterparty.detail.status",
] as const;

/**
 * Picks the status to display for a provider account: the provider's own status when one
 * exists, otherwise SDP's.
 *
 * @param account - The provider account or customer link.
 * @returns The status string to render.
 */
function providerAccountStatus(
  account: Pick<CounterpartyProviderAccount, "status" | "providerStatus">
): string {
  return account.providerStatus === null ? account.status : account.providerStatus;
}

/**
 * A provider-side status in words. Provider statuses are an open vocabulary, so anything outside
 * the known settled/failed set reads as still in progress.
 */
function ProviderAccountStatus({ status }: { status: string }) {
  const tone = PROVIDER_ACCOUNT_STATUS_TONE.get(status.toLowerCase());
  return (
    <StatusText tone={tone === undefined ? "attention" : tone}>{toTitleCase(status)}</StatusText>
  );
}

function Missing() {
  return <span className="text-tertiary">—</span>;
}

/** A funding wallet's live balance, a note when the provider read failed, a dash before it exists. */
function FundingWalletBalance({ account }: { account: CounterpartyProviderAccount }) {
  const t = useTranslations();
  const balance = account.balance;
  return (
    <span className="inline-flex items-center gap-1.5">
      {balance === undefined ? (
        <Missing />
      ) : balance.state === "unavailable" ? (
        <span className="text-tertiary">
          {t("DashboardPayments.counterparty.providerAccountBalanceUnavailable")}
        </span>
      ) : (
        <span className="tabular-nums">
          {formatDisplayAmount(balance.amount, balance.currency)}
        </span>
      )}
      {account.providerAccountReference === undefined ? null : (
        <WalletMetadataCopyButton
          value={account.providerAccountReference}
          label={t("DashboardPayments.counterparty.walletIdLabel")}
          tooltip={account.providerAccountReference}
        />
      )}
    </span>
  );
}

/** A funding wallet's cells: its currency, no rail, and its balance in the account column. */
function FundingWalletCells({ account }: { account: CounterpartyProviderAccount }) {
  const t = useTranslations();
  return (
    <>
      <TableCell className="text-body text-secondary">
        {account.fiatCurrency === null ? (
          <Missing />
        ) : (
          t("DashboardPayments.counterparty.providerAccountFundingWallet", {
            currency: account.fiatCurrency,
          })
        )}
      </TableCell>
      <TableCell className="text-body">
        <Missing />
      </TableCell>
      <TableCell className="text-body text-secondary">
        <FundingWalletBalance account={account} />
      </TableCell>
    </>
  );
}

/** A stored payout account's cells: its corridor and rail; nothing in the account column. */
function PayoutAccountCells({ account }: { account: CounterpartyProviderAccount }) {
  return (
    <>
      <TableCell className="truncate text-body text-secondary">
        {account.fiatCurrency === null ? (
          <Missing />
        ) : account.destinationCountry === null ? (
          account.fiatCurrency
        ) : (
          `${account.fiatCurrency} → ${account.destinationCountry}`
        )}
      </TableCell>
      <TableCell className="truncate text-body text-secondary">
        {account.paymentRail === null ? <Missing /> : account.paymentRail}
      </TableCell>
      <TableCell className="text-body">
        <Missing />
      </TableCell>
    </>
  );
}

/** The provider's customer record for this contact: where it is registered, and its id. */
function CustomerLinkCells({ link }: { link: CounterpartyProviderCustomerLink | undefined }) {
  const t = useTranslations();
  return (
    <>
      <TableCell className="text-body text-secondary">
        <Missing />
      </TableCell>
      <TableCell className="text-body">
        <Missing />
      </TableCell>
      <TableCell className="text-body text-secondary">
        <span className="inline-flex items-center gap-1.5">
          {t("DashboardPayments.counterparty.detail.customerProfile")}
          {link === undefined || link.providerCustomerReference === null ? null : (
            <WalletMetadataCopyButton
              value={link.providerCustomerReference}
              label={t("DashboardPayments.counterparty.customerIdLabel")}
              tooltip={link.providerCustomerReference}
            />
          )}
        </span>
      </TableCell>
    </>
  );
}

/** The corridor, rail and account cells of one provider-account row, by its kind. */
function ProviderAccountCells({ account }: { account: CounterpartyProviderAccount }) {
  if (account.kind === "funding_wallet") {
    return <FundingWalletCells account={account} />;
  }
  if (account.kind === "payout_account") {
    return <PayoutAccountCells account={account} />;
  }
  return <CustomerLinkCells link={account.customerLink} />;
}

/** One row of the table: a provider's customer record, or one account the provider holds. */
type ProviderAccountRow = { key: string; provider: PersistedRampProviderId } & (
  | { kind: "customer"; link: CounterpartyProviderCustomerLink }
  | { kind: "account"; account: CounterpartyProviderAccount }
);

/**
 * The table's rows: each provider's customer record once, ahead of that provider's accounts.
 * The API sends a separate customer-link row only when the provider holds no accounts for the
 * contact; otherwise the link rides on each account, so it is lifted into its own row here.
 *
 * @param accounts - Provider-account rows from the API.
 * @returns The rows to render, in the API's order.
 */
function providerAccountRows(accounts: CounterpartyProviderAccount[]): ProviderAccountRow[] {
  const rows: ProviderAccountRow[] = [];
  const linkedProviders = new Set<PersistedRampProviderId>();
  for (const account of accounts) {
    const link = account.customerLink;
    if (link !== undefined && !linkedProviders.has(account.provider)) {
      linkedProviders.add(account.provider);
      rows.push({ kind: "customer", key: `customer:${link.id}`, provider: account.provider, link });
    }
    if (account.kind !== "customer_link" || link === undefined) {
      rows.push({ kind: "account", key: account.id, provider: account.provider, account });
    }
  }
  return rows;
}

/**
 * The contact's provider accounts as the design's table, one row per account the providers
 * hold for this contact: payout accounts (corridor, rail, bank, account), funding wallets
 * (with their live balance) and customer records. Agreements a provider wants accepted follow
 * the table. Covers the loading, error and empty states of the fetch the page owns; a refresh
 * that fails after a successful read keeps the rows it loaded and says the refresh failed.
 *
 * @param props.accounts - Provider-account rows, undefined while loading.
 * @param props.error - Fetch error, if the request failed.
 * @returns The provider-accounts block body.
 */
export function CounterpartyProviderAccounts({
  accounts,
  error,
}: {
  accounts: CounterpartyProviderAccount[] | undefined;
  error: unknown;
}) {
  const t = useTranslations();
  const errorMessage =
    error instanceof Error ? error.message : t("DashboardPayments.counterparty.somethingWentWrong");

  // With nothing loaded to show, the failure is the block's whole content.
  if (error && (accounts === undefined || accounts.length === 0)) {
    return (
      <p className="text-body">
        <StatusText tone="critical">
          {t("DashboardPayments.counterparty.detail.providerAccountsFailed", {
            error: errorMessage,
          })}
        </StatusText>
      </p>
    );
  }
  if (accounts === undefined) {
    return (
      <p className="text-body text-tertiary" aria-busy="true">
        {t("DashboardPayments.counterparty.loadingProviderAccounts")}
      </p>
    );
  }
  if (accounts.length === 0) {
    return (
      <ListEmptyState
        message={t("DashboardPayments.counterparty.detail.noProviderAccounts")}
        description={t("DashboardPayments.counterparty.detail.noProviderAccountsDescription")}
      />
    );
  }
  const rows = providerAccountRows(accounts);
  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p className="text-body">
          <StatusText tone="critical">
            {t("DashboardPayments.counterparty.detail.providerAccountsRefreshFailed", {
              error: errorMessage,
            })}
          </StatusText>
        </p>
      ) : null}
      <div className="overflow-x-auto refresh:-mx-3">
        <Table className="min-w-[720px] table-fixed rounded-none border-0">
          <TableHeader>
            <TableRow>
              {PROVIDER_ACCOUNT_COLUMN_KEYS.map((key) => (
                <TableHead key={key}>{t(key)}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.key}
                data-provider-account-kind={
                  row.kind === "customer" ? "customer_link" : row.account.kind
                }
              >
                <TableCell className="truncate text-body text-primary">
                  {getRampProviderLabel(row.provider)}
                </TableCell>
                {row.kind === "customer" ? (
                  <CustomerLinkCells link={row.link} />
                ) : (
                  <ProviderAccountCells account={row.account} />
                )}
                <TableCell className="text-body whitespace-nowrap">
                  <ProviderAccountStatus
                    status={providerAccountStatus(row.kind === "customer" ? row.link : row.account)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
