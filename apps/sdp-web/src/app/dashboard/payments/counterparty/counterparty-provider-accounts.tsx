"use client";

import {
  BVNK_FUNDING_WALLET_STATUSES,
  type BvnkFundingWalletStatus,
  type CounterpartyProviderAccount,
  type CounterpartyProviderCustomerLinkAgreement,
} from "@sdp/types";
import { regionFlagEmoji } from "@sdp/types/payment-rails";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
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
import { openBvnkCustomerLink } from "@/lib/trusted-ramp-destinations";
import { toTitleCase } from "../../activity-format-utils";
import { formatDisplayAmount, formatTimestamp } from "../payments-overview.utils";
import { groupProviderAccounts } from "./counterparty-provider-accounts.utils";

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

const FUNDING_WALLET_STATUS_LABEL_KEY = {
  provisioning_funding_wallet: "DashboardPayments.counterparty.providerAccountWalletProvisioning",
  provisioned_funding_wallet: "DashboardPayments.counterparty.providerAccountWalletActive",
} as const satisfies Record<BvnkFundingWalletStatus, string>;

function isBvnkFundingWalletStatus(value: string): value is BvnkFundingWalletStatus {
  return BVNK_FUNDING_WALLET_STATUSES.some((status) => status === value);
}

/**
 * Picks the status to display for a provider account: enriched payout accounts show SDP's
 * status, everything else shows the provider's own status when one exists.
 *
 * @param account - The provider account or customer link.
 * @returns The status string to render.
 */
function providerAccountStatus(
  account: Pick<
    CounterpartyProviderAccount,
    "status" | "providerStatus" | "bankName" | "accountNumberLast4" | "paymentRails"
  >
): string {
  const hasEnrichment =
    account.bankName !== undefined ||
    account.accountNumberLast4 !== undefined ||
    account.paymentRails !== undefined;
  if (hasEnrichment || account.providerStatus === null) {
    return account.status;
  }
  return account.providerStatus;
}

/**
 * A provider-side status in words. Provider statuses are an open vocabulary, so anything outside
 * the known settled/failed set reads as still in progress.
 */
function ProviderAccountStatus({ status }: { status: string }) {
  const t = useTranslations();
  const tone = PROVIDER_ACCOUNT_STATUS_TONE.get(status.toLowerCase());
  return (
    <StatusText tone={tone === undefined ? "attention" : tone}>
      {isBvnkFundingWalletStatus(status)
        ? t(FUNDING_WALLET_STATUS_LABEL_KEY[status])
        : toTitleCase(status)}
    </StatusText>
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

/** The corridor, rail, bank and account cells of one provider-account row, by its kind. */
function ProviderAccountCells({ account }: { account: CounterpartyProviderAccount }) {
  const t = useTranslations();
  if (account.kind === "funding_wallet") {
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
        <TableCell className="text-body">
          <Missing />
        </TableCell>
        <TableCell className="text-body text-secondary">
          <FundingWalletBalance account={account} />
        </TableCell>
      </>
    );
  }
  if (account.kind === "payout_account") {
    const rail =
      account.paymentRail === null ? account.paymentRails?.join(", ") : account.paymentRail;
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
          {rail === undefined ? <Missing /> : rail}
        </TableCell>
        <TableCell className="truncate text-body text-secondary">
          {account.bankName === undefined ? <Missing /> : account.bankName}
        </TableCell>
        <TableCell className="text-body whitespace-nowrap text-secondary tabular-nums">
          {account.accountNumberLast4 === undefined ? (
            <Missing />
          ) : (
            `···· ${account.accountNumberLast4}`
          )}
        </TableCell>
      </>
    );
  }
  // The provider's customer record for this contact: where it is registered, and its id.
  const link = account.customerLink;
  return (
    <>
      <TableCell className="text-body text-secondary">
        {link?.provider === "bvnk" ? (
          <span title={t("DashboardPayments.counterparty.taxResidence")}>
            <span aria-hidden="true">{regionFlagEmoji(link.residenceCountryCode)}</span>{" "}
            {link.residenceCountryCode}
          </span>
        ) : (
          <Missing />
        )}
      </TableCell>
      <TableCell className="text-body">
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

/** The provider agreements a contact is asked to accept, with where each one stands. */
function ProviderAgreements({
  agreements,
}: {
  agreements: { provider: string; agreement: CounterpartyProviderCustomerLinkAgreement }[];
}) {
  const t = useTranslations();
  return (
    <ul className="flex flex-col gap-2 text-body">
      {agreements.map(({ provider, agreement }) => (
        <li
          key={`${provider}:${agreement.name}`}
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span className="text-secondary">{provider}</span>
          <span className="min-w-0 truncate text-primary">{agreement.displayName}</span>
          {agreement.signedAt === null ? (
            <StatusText tone="attention">
              {t("DashboardPayments.counterparty.agreementAwaitingSignature")}
            </StatusText>
          ) : (
            <span title={formatTimestamp(agreement.signedAt, t)}>
              <StatusText tone="positive">
                {t("DashboardPayments.counterparty.agreementSigned")}
              </StatusText>
            </span>
          )}
          <button
            type="button"
            className="text-secondary underline underline-offset-4 hover:text-primary"
            onClick={() => openBvnkCustomerLink(agreement.url)}
          >
            {t("DashboardPayments.counterparty.viewAgreement")}
          </button>
          <button
            type="button"
            className="text-secondary underline underline-offset-4 hover:text-primary"
            onClick={() => openBvnkCustomerLink(agreement.privacyPolicyUrl)}
          >
            {t("DashboardPayments.counterparty.viewPrivacyPolicy")}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The contact's provider accounts as the design's table, one row per account the providers
 * hold for this contact: payout accounts (corridor, rail, bank, account), funding wallets
 * (with their live balance) and customer records. Agreements a provider wants accepted follow
 * the table. Covers the loading, error and empty states of the fetch the page owns.
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

  if (error) {
    return (
      <p className="text-body">
        <StatusText tone="critical">
          {t("DashboardPayments.counterparty.detail.providerAccountsFailed", {
            error:
              error instanceof Error
                ? error.message
                : t("DashboardPayments.counterparty.somethingWentWrong"),
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
  const agreements = groupProviderAccounts(accounts).flatMap((group) =>
    group.customerLink?.provider === "bvnk"
      ? group.customerLink.agreements.map((agreement) => ({
          provider: getRampProviderLabel(group.provider),
          agreement,
        }))
      : []
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto refresh:-mx-3">
        <Table className="min-w-[720px] table-fixed rounded-none border-0">
          <TableHeader>
            <TableRow>
              <TableHead>{t("DashboardPayments.counterparty.detail.provider")}</TableHead>
              <TableHead>{t("DashboardPayments.counterparty.detail.corridor")}</TableHead>
              <TableHead>{t("DashboardPayments.counterparty.detail.rail")}</TableHead>
              <TableHead>{t("DashboardPayments.counterparty.detail.bank")}</TableHead>
              <TableHead>{t("DashboardPayments.counterparty.detail.account")}</TableHead>
              <TableHead>{t("DashboardPayments.counterparty.detail.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.id} data-provider-account-kind={account.kind}>
                <TableCell className="truncate text-body text-primary">
                  {getRampProviderLabel(account.provider)}
                </TableCell>
                <ProviderAccountCells account={account} />
                <TableCell className="text-body whitespace-nowrap">
                  <ProviderAccountStatus
                    status={providerAccountStatus(
                      account.kind === "customer_link" && account.customerLink !== undefined
                        ? account.customerLink
                        : account
                    )}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {agreements.length > 0 ? <ProviderAgreements agreements={agreements} /> : null}
    </div>
  );
}
