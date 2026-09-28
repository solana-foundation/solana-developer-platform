"use client";

import {
  BVNK_FUNDING_WALLET_STATUSES,
  type BvnkFundingWalletStatus,
  type CounterpartyProviderAccount,
  type CounterpartyProviderCustomerLink,
  type CounterpartyProviderCustomerLinkAgreement,
  type RampProviderId,
} from "@sdp/types";
import { regionFlagEmoji } from "@sdp/types/payment-rails";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ClockIcon,
  LoaderCircleIcon,
  WalletIcon,
} from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { useTranslations } from "@/i18n/provider";
import {
  getRampProviderLabel,
  RAMP_PROVIDER_HAS_PAYOUT_ACCOUNTS,
  RAMP_PROVIDER_LOGOS,
} from "@/lib/ramps";
import { openBvnkCustomerLink } from "@/lib/trusted-ramp-destinations";
import { cn } from "@/lib/utils";
import { formatRelativeTime, toTitleCase } from "../../activity-format-utils";
import { formatDisplayAmount, formatTimestamp } from "../payments-overview.utils";
import {
  type FundingWalletAccount,
  groupProviderAccounts,
  type ProviderCustomerGroup,
} from "./counterparty-provider-accounts.utils";

const PROVIDER_ACCOUNT_STATUS_VARIANT: ReadonlyMap<string, BadgeVariant> = new Map([
  ["active", "success"],
  ["completed", "success"],
  ["ready", "success"],
  ["archived", "danger"],
  ["failed", "danger"],
  ["rejected", "danger"],
  ["provisioned_funding_wallet", "success"],
]);

const FUNDING_WALLET_STATUS_LABEL_KEY = {
  provisioning_funding_wallet: "DashboardPayments.counterparty.providerAccountWalletProvisioning",
  provisioned_funding_wallet: "DashboardPayments.counterparty.providerAccountWalletActive",
} as const satisfies Record<BvnkFundingWalletStatus, string>;

function isBvnkFundingWalletStatus(value: string): value is BvnkFundingWalletStatus {
  return BVNK_FUNDING_WALLET_STATUSES.some((status) => status === value);
}

/**
 * Renders a provider-side status string as a badge. Provider statuses are an
 * open vocabulary, so anything outside the known success/danger set reads as
 * in progress.
 *
 * @param props.status - Raw status string from SDP or the provider.
 * @param props.label - Translated label to show instead of the title-cased status.
 * @returns The status badge.
 */
function ProviderAccountStatusBadge({ status, label }: { status: string; label?: string }) {
  const variant = PROVIDER_ACCOUNT_STATUS_VARIANT.get(status.toLowerCase());
  return (
    <Badge variant={variant === undefined ? "warning" : variant}>
      {label === undefined ? toTitleCase(status) : label}
    </Badge>
  );
}

/**
 * Picks the status to display for a provider account: enriched payout
 * accounts show SDP's status, everything else shows the provider's own status
 * when one exists.
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

function CustomerLinkAgreements({
  agreements,
}: {
  agreements: CounterpartyProviderCustomerLinkAgreement[];
}) {
  const t = useTranslations();
  return (
    <>
      {agreements.map((agreement) => (
        <div
          key={agreement.name}
          className="flex min-w-0 items-center gap-2 border-t border-border-default px-4 py-2 text-sm"
        >
          {agreement.signedAt !== null ? (
            <span
              className="flex shrink-0 items-center gap-1 text-success"
              title={formatTimestamp(agreement.signedAt, t)}
            >
              <CheckCircle2Icon className="size-4" />
              {t("DashboardPayments.counterparty.agreementSigned")}
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1 text-tertiary">
              <ClockIcon className="size-4" />
              {t("DashboardPayments.counterparty.agreementAwaitingSignature")}
            </span>
          )}
          <span className="truncate text-primary">{agreement.displayName}</span>
          <button
            type="button"
            className="underline underline-offset-2 text-tertiary hover:text-primary"
            onClick={() => openBvnkCustomerLink(agreement.url)}
          >
            {t("DashboardPayments.counterparty.viewAgreement")}
          </button>
          <button
            type="button"
            className="underline underline-offset-2 text-tertiary hover:text-primary"
            onClick={() => openBvnkCustomerLink(agreement.privacyPolicyUrl)}
          >
            {t("DashboardPayments.counterparty.viewPrivacyPolicy")}
          </button>
        </div>
      ))}
    </>
  );
}

function ProviderCustomerHeader({
  provider,
  customerLink,
}: {
  provider: RampProviderId;
  customerLink: CounterpartyProviderCustomerLink | undefined;
}) {
  const t = useTranslations();
  return (
    <>
      <Image
        src={RAMP_PROVIDER_LOGOS[provider]}
        alt=""
        width={20}
        height={20}
        className="size-5 rounded"
      />
      <span className="text-sm font-medium text-primary">{getRampProviderLabel(provider)}</span>
      {customerLink !== undefined ? (
        <>
          <span className="text-xs uppercase tracking-wide text-tertiary">
            {t("DashboardPayments.counterparty.providerAccountCustomer")}
          </span>
          <ProviderAccountStatusBadge status={providerAccountStatus(customerLink)} />
          {customerLink.provider === "bvnk" ? (
            <span
              className="text-xs text-tertiary"
              title={t("DashboardPayments.counterparty.taxResidence")}
            >
              <span aria-hidden="true">{regionFlagEmoji(customerLink.residenceCountryCode)}</span>{" "}
              {customerLink.residenceCountryCode}
            </span>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function CustomerLinkMeta({ customerLink }: { customerLink: CounterpartyProviderCustomerLink }) {
  const t = useTranslations();
  const customerReference = customerLink.providerCustomerReference;
  return (
    <div className="flex min-w-0 items-center gap-1">
      {customerReference !== null ? (
        <WalletMetadataCopyButton
          value={customerReference}
          label={t("DashboardPayments.counterparty.customerIdLabel")}
          tooltip={customerReference}
        />
      ) : null}
      <span
        className="whitespace-nowrap text-xs text-tertiary"
        title={formatTimestamp(customerLink.createdAt, t)}
      >
        {formatRelativeTime(customerLink.createdAt)}
      </span>
    </div>
  );
}

/**
 * Renders the live-balance cell of a funding-wallet row: the formatted amount
 * plus currency when available, a muted badge when the provider read failed,
 * and an em dash while no provider wallet exists yet.
 *
 * @param props.balance - The row's just-in-time balance, absent during provisioning.
 * @returns The balance cell content.
 */
function ProviderWalletBalanceCell({
  balance,
}: {
  balance: CounterpartyProviderAccount["balance"];
}) {
  const t = useTranslations();
  if (balance === undefined) {
    return <span className="text-sm text-tertiary">—</span>;
  }
  if (balance.state === "unavailable") {
    return (
      <Badge variant="default">
        {t("DashboardPayments.counterparty.providerAccountBalanceUnavailable")}
      </Badge>
    );
  }
  return (
    <span className="whitespace-nowrap text-sm tabular-nums text-primary">
      {formatDisplayAmount(balance.amount, balance.currency)}
    </span>
  );
}

function FundingWalletsList({ accounts }: { accounts: FundingWalletAccount[] }) {
  const t = useTranslations();
  return (
    <ul className="border-t border-border-default">
      {accounts.map((account) => {
        const walletStatus = providerAccountStatus(account);
        return (
          <li
            key={account.id}
            className="flex items-center gap-3 border-b border-border-default px-4 py-3 last:border-b-0"
          >
            <span className="text-sm text-primary">
              {t("DashboardPayments.counterparty.providerAccountFundingWallet", {
                currency: account.fiatCurrency,
              })}
            </span>
            {account.providerAccountReference !== undefined ? (
              <WalletMetadataCopyButton
                value={account.providerAccountReference}
                label={t("DashboardPayments.counterparty.walletIdLabel")}
                tooltip={account.providerAccountReference}
              />
            ) : null}
            <span className="ml-auto">
              <ProviderWalletBalanceCell balance={account.balance} />
            </span>
            <ProviderAccountStatusBadge
              status={walletStatus}
              label={
                isBvnkFundingWalletStatus(walletStatus)
                  ? t(FUNDING_WALLET_STATUS_LABEL_KEY[walletStatus])
                  : undefined
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

function PayoutAccountsTable({ accounts }: { accounts: CounterpartyProviderAccount[] }) {
  const t = useTranslations();
  const headers = [
    t("DashboardPayments.counterparty.providerAccountCorridor"),
    t("DashboardPayments.counterparty.providerAccountRail"),
    t("DashboardPayments.counterparty.providerAccountBank"),
    t("DashboardPayments.counterparty.providerAccountNumber"),
    t("DashboardPayments.counterparty.providerAccountStatus"),
  ];
  return (
    <div className="overflow-x-auto border-t border-border-default">
      <table className="w-full min-w-max border-collapse text-left">
        <thead>
          <tr className="border-b border-border-default">
            {headers.map((header) => (
              <th
                key={header}
                className="whitespace-nowrap px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-secondary"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.id} className="border-b border-border-default last:border-b-0">
              <td className="whitespace-nowrap px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-primary">
                  <span>{account.fiatCurrency}</span>
                  {account.destinationCountry !== null ? (
                    <>
                      <span aria-hidden="true">{regionFlagEmoji(account.destinationCountry)}</span>
                      <span className="sr-only">{account.destinationCountry}</span>
                    </>
                  ) : null}
                </div>
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                {account.paymentRail !== null ? (
                  <Badge variant="outline">{account.paymentRail}</Badge>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-sm text-primary">
                {account.bankName}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-sm text-primary">
                {account.accountNumberLast4 !== undefined
                  ? `•••• ${account.accountNumberLast4}`
                  : null}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <ProviderAccountStatusBadge status={providerAccountStatus(account)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProviderCustomerCard({ group }: { group: ProviderCustomerGroup }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const { provider, customerLink, payoutAccounts, fundingWallets } = group;
  const expandable =
    payoutAccounts.length > 0 ||
    fundingWallets.length > 0 ||
    (customerLink !== undefined && customerLink.provider === "bvnk") ||
    RAMP_PROVIDER_HAS_PAYOUT_ACCOUNTS[provider];

  return (
    <div className="rounded-lg border border-border-default bg-surface-raised">
      <div className="flex items-center gap-2 px-4 py-3">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 text-secondary transition-transform",
                !open && "-rotate-90"
              )}
            />
            <ProviderCustomerHeader provider={provider} customerLink={customerLink} />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ProviderCustomerHeader provider={provider} customerLink={customerLink} />
          </div>
        )}
        {customerLink !== undefined ? <CustomerLinkMeta customerLink={customerLink} /> : null}
      </div>
      {expandable && open ? (
        <>
          {fundingWallets.length > 0 ? <FundingWalletsList accounts={fundingWallets} /> : null}
          {payoutAccounts.length > 0 ? (
            <PayoutAccountsTable accounts={payoutAccounts} />
          ) : RAMP_PROVIDER_HAS_PAYOUT_ACCOUNTS[provider] ? (
            <p className="border-t border-border-default px-4 py-3 text-sm text-tertiary">
              {t("DashboardPayments.counterparty.noPayoutAccounts")}
            </p>
          ) : null}
          {customerLink !== undefined && customerLink.provider === "bvnk" ? (
            <CustomerLinkAgreements agreements={customerLink.agreements} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Renders the counterparty's provider accounts grouped by provider, covering
 * the loading, error, and empty states of the fetch the workspace owns.
 *
 * @param props.accounts - Provider-account rows, undefined while loading.
 * @param props.error - Fetch error, if the request failed.
 * @returns The provider-accounts section body.
 */
export function CounterpartyProviderAccounts({
  accounts: providerAccounts,
  error: providerAccountsError,
}: {
  accounts: CounterpartyProviderAccount[] | undefined;
  error: unknown;
}) {
  const t = useTranslations();

  if (providerAccountsError) {
    return (
      <div className="rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
        {providerAccountsError instanceof Error ? providerAccountsError.message : null}
      </div>
    );
  }
  if (providerAccounts === undefined) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border-default bg-surface-raised px-4 py-5 text-sm text-tertiary">
        <LoaderCircleIcon className="size-4 animate-spin" />
        {t("DashboardPayments.counterparty.loadingProviderAccounts")}
      </div>
    );
  }
  if (providerAccounts.length === 0) {
    return (
      <ListEmptyState
        className="min-h-0 rounded-lg border border-dashed border-border-strong py-10"
        icon={<WalletIcon className="size-5" />}
        message={t("DashboardPayments.counterparty.noProviderAccounts")}
      />
    );
  }
  return (
    <div className="space-y-3">
      {groupProviderAccounts(providerAccounts).map((group) => (
        <ProviderCustomerCard key={group.provider} group={group} />
      ))}
    </div>
  );
}
