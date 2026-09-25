"use client";

import {
  CUSTODY_PROVIDER_CATALOG_BY_ID,
  type PaymentsDashboardWallet,
  type PaymentTransferSummary,
} from "@sdp/types";
import { ChevronDownIcon, CopyIcon, InfoIcon, PlusIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { StatusText } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import {
  resolveTransferTokenLabel,
  shortenAddress,
  statusMessageKey,
} from "../../payments-overview.utils";
import { formatDate, formatSignedAmount, PAYMENT_STATUS_TONE } from "../../payments-presentation";
import { paymentsQueryKeys } from "../../payments-query-key";
import { fetchTransfers } from "../../payments-workspace.data";
import { usePaymentsActionWallets } from "../hooks/use-payments-action-wallets";

const RECENT_DEPOSIT_COUNT = 5;
// How often the recent deposits re-read while the page is open; the "watching" line is true
// because of this poll, not because of a push channel.
const DEPOSIT_POLL_MS = 15_000;

function walletProviderLabel(wallet: PaymentsDashboardWallet): string | null {
  return wallet.provider ? CUSTODY_PROVIDER_CATALOG_BY_ID[wallet.provider].label : null;
}

/**
 * A deposit's amount, signed as money in, beside what it is in: the fiat side for a ramp, else
 * the token. Two parts, so the table can set the asset in the secondary colour as the design does.
 */
function depositAmount(
  deposit: PaymentTransferSummary,
  issuedTokenSymbolsByMint: Readonly<Record<string, string>>,
  locale: string
): { amount: string; asset: string | undefined } | null {
  const isFiat = deposit.fiatAmount !== undefined && deposit.fiatCurrency !== undefined;
  const amount = formatSignedAmount(
    isFiat ? deposit.fiatAmount : deposit.amount,
    "inbound",
    undefined,
    locale
  );
  if (amount === null) return null;
  return {
    amount,
    asset: isFiat
      ? deposit.fiatCurrency?.toUpperCase()
      : resolveTransferTokenLabel(deposit.token, issuedTokenSymbolsByMint),
  };
}

function walletName(wallet: PaymentsDashboardWallet): string {
  return wallet.label ?? shortenAddress(wallet.publicKey);
}

/**
 * The address as a code. A phone shows it on the design's 176px white plate, dark modules in
 * both themes; from sm it is the 128px code beside the text column, bare in the light theme and
 * on a white tile with an 8px quiet zone in the dark one, so its finder squares never touch the
 * card.
 */
function AddressQr({ address, className }: { address: string; className?: string }) {
  const t = useTranslations();
  const { data } = useSWR(
    paymentsQueryKeys.walletAddressQr(address),
    () =>
      QRCode.toDataURL(address, {
        margin: 0,
        width: 288,
        color: { dark: "#0f0f12", light: "#00000000" },
      }),
    { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false }
  );
  return (
    <div
      className={cn(
        "size-44 shrink-0 rounded-control bg-white p-4 sm:size-32 sm:rounded-sm sm:bg-transparent sm:p-0 sm:dark:bg-white sm:dark:p-2",
        className
      )}
    >
      {data ? (
        <Image
          src={data}
          alt={t("DashboardPayments.ramps.walletAddressQrCode")}
          width={144}
          height={144}
          unoptimized
          className="size-full"
        />
      ) : (
        <div className="size-full animate-pulse rounded-control bg-fill" />
      )}
    </div>
  );
}

/** The wallet to deposit into, chosen from the project's wallets, with its provider beside it. */
function WalletPicker({
  wallet,
  wallets,
  onSelect,
}: {
  wallet: PaymentsDashboardWallet;
  wallets: readonly PaymentsDashboardWallet[];
  onSelect: (walletId: string) => void;
}) {
  const t = useTranslations();
  const provider = walletProviderLabel(wallet);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex max-w-full items-center gap-1.5 self-start rounded-control-inner py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-body font-medium text-primary">{walletName(wallet)}</span>
          {provider ? <span className="shrink-0 text-meta text-tertiary">{provider}</span> : null}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-secondary" aria-hidden="true" />
        <span className="sr-only">{t("DashboardPayments.depositAddress.chooseWallet")}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuRadioGroup value={wallet.id} onValueChange={onSelect}>
          {wallets.map((candidate) => (
            <DropdownMenuRadioItem
              key={candidate.id}
              value={candidate.id}
              className="text-body font-normal"
            >
              <span className="min-w-0 truncate">{walletName(candidate)}</span>
              {walletProviderLabel(candidate) ? (
                <span className="ml-auto pl-3 text-meta text-tertiary">
                  {walletProviderLabel(candidate)}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The design's 160px card: a 128px code in a 16px inset, 16px from the text column; the wallet
 * (14px, its provider 13px) and the address (16px mono, a 24px copy control beside it) at the
 * top of the column, the network warning (13px) at its foot. The column has no padding of its
 * own, which is what leaves a 44-character address room for one line. On a phone the card
 * stacks: the code first, centred on its plate, then the wallet, the address, a full-width copy
 * button and the warning.
 */
function AddressCard({
  wallet,
  wallets,
  network,
  onSelectWallet,
  onCopy,
}: {
  wallet: PaymentsDashboardWallet;
  wallets: readonly PaymentsDashboardWallet[];
  network: string;
  onSelectWallet: (walletId: string) => void;
  onCopy: () => void;
}) {
  const t = useTranslations();
  return (
    <section className="flex flex-col gap-4 rounded-card border border-border-default bg-fill-subtle p-4 sm:flex-row sm:items-stretch">
      <AddressQr address={wallet.publicKey} className="self-center sm:order-last sm:self-auto" />
      <div className="flex min-w-0 flex-1 flex-col sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <WalletPicker wallet={wallet} wallets={wallets} onSelect={onSelectWallet} />
          <div className="flex items-start gap-2">
            <p className="min-w-0 font-mono text-field break-all text-primary">
              {wallet.publicKey}
            </p>
            {/* Wrapped, not classed: the design-system button sets its own display. */}
            <span className="hidden sm:contents">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="mt-0.5 text-tertiary hover:text-primary"
                aria-label={t("DashboardPayments.ramps.copyAddress")}
                onClick={onCopy}
              >
                <CopyIcon className="size-3.5" />
              </Button>
            </span>
          </div>
        </div>
        {/* The phone's copy control: the design's full-width 44px outline button, 20px under
            the address. From sm the icon beside the address does it. */}
        <Button
          type="button"
          variant="outline"
          iconLeft={<CopyIcon />}
          onClick={onCopy}
          className="mt-4 h-11 w-full text-field sm:hidden"
        >
          {t("DashboardPayments.ramps.copyAddress")}
        </Button>
        <p className="mt-4 text-meta text-secondary sm:mt-0">
          {t("DashboardPayments.depositAddress.networkWarning", { network })}
        </p>
      </div>
    </section>
  );
}

/** What the address accepts, its minimum and how fast it lands: 14px on 40px rows over faint rules. */
function DepositFacts() {
  const t = useTranslations();
  const rows = [
    {
      label: t("DashboardPayments.depositAddress.accepts"),
      value: t("DashboardPayments.depositAddress.acceptsValue"),
    },
    {
      label: t("DashboardPayments.depositAddress.minimum"),
      value: t("DashboardPayments.depositAddress.minimumValue"),
    },
    {
      label: t("DashboardPayments.depositAddress.arrives"),
      value: t("DashboardPayments.depositAddress.arrivesValue"),
      hint: t("DashboardPayments.depositAddress.arrivesHint"),
    },
  ];
  return (
    <dl className="mt-6 divide-y divide-border-subtle">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-4 py-2.5">
          <dt className="text-body text-secondary">{row.label}</dt>
          <dd className="flex items-center gap-1.5 text-body text-primary">
            {row.value}
            {row.hint ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={row.hint}
                      className="inline-flex text-tertiary hover:text-primary"
                    >
                      <InfoIcon className="size-4" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-64 text-xs">
                    {row.hint}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The wallet's last few deposits, or why there are none to show. */
function RecentDeposits({
  wallet,
  deposits,
  depositsError,
  issuedTokenSymbolsByMint,
}: {
  wallet: PaymentsDashboardWallet;
  deposits: PaymentTransferSummary[] | undefined;
  depositsError: unknown;
  issuedTokenSymbolsByMint: Record<string, string>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  let body: ReactNode;
  if (depositsError) {
    body = (
      <p className="text-body text-tertiary">
        {t("DashboardPayments.depositAddress.recentUnavailable")}
      </p>
    );
  } else if (deposits === undefined) {
    body = <div className="h-32 animate-pulse rounded-control bg-fill-subtle" />;
  } else if (deposits.length === 0) {
    body = (
      <p className="py-6 text-body text-tertiary">
        {t("DashboardPayments.depositAddress.noDeposits")}
      </p>
    );
  } else {
    body = (
      <Table className="table-fixed rounded-none border-0 refresh:-mx-3">
        {/* Where the design's columns start in its 660px column: Amount at 136px, Contact at
            319, Created at 577 (its own table runs wider than the card and is clipped). */}
        <colgroup>
          <col className="w-[19.5%]" />
          <col className="w-[26.5%]" />
          <col className="w-[37.75%]" />
          <col className="w-[16.25%]" />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>{t("DashboardPayments.status")}</TableHead>
            <TableHead>{t("DashboardPayments.commandCenter.amount")}</TableHead>
            <TableHead>{t("DashboardPayments.transactions.contact")}</TableHead>
            <TableHead>{t("DashboardPayments.createdLabel")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deposits.map((deposit) => {
            const amount = depositAmount(deposit, issuedTokenSymbolsByMint, locale);
            const contact =
              deposit.counterpartyDisplayName ??
              (deposit.source ? shortenAddress(deposit.source) : null);
            return (
              <TableRow key={deposit.id}>
                <TableCell>
                  <StatusText tone={PAYMENT_STATUS_TONE[deposit.status]} className="text-body">
                    {t(statusMessageKey(deposit.status))}
                  </StatusText>
                </TableCell>
                <TableCell className="truncate text-body font-medium text-primary tabular-nums">
                  {amount === null ? (
                    "—"
                  ) : (
                    <>
                      {amount.amount}
                      {amount.asset ? (
                        <span className="font-normal text-secondary"> {amount.asset}</span>
                      ) : null}
                    </>
                  )}
                </TableCell>
                <TableCell className="truncate text-body text-primary">{contact ?? "—"}</TableCell>
                <TableCell className="truncate text-body text-secondary">
                  {formatDate(deposit.createdAt, locale)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }
  return (
    // 64px from the line above: the design's 24px rhythm plus the 40 a new block opens with.
    <section className="mt-16 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-subheading font-medium text-primary">
          {t("DashboardPayments.depositAddress.recentTitle")}
        </h2>
        {/* The design's block action is its 30px control. */}
        <Button asChild variant="outline" size="sm" className="[--button-height-md:1.875rem]">
          <Link
            href={`/dashboard/payments/transactions?module=payments&custodyWalletId=${encodeURIComponent(wallet.id)}`}
          >
            {t("DashboardPayments.depositAddress.openInTransactions")}
          </Link>
        </Button>
      </div>
      {body}
    </section>
  );
}

/**
 * Deposit's "Solana address" tab: one wallet's address to send to, what it accepts, and the
 * deposits it has received. No contact is needed; anyone can send to an address.
 */
export function DepositAddressPanel({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
}: {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = useSolanaCluster();
  const { liveWallets, walletsLoading, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const wallet = liveWallets.find((candidate) => candidate.id === selectedId) ?? liveWallets[0];

  const { data: deposits, error: depositsError } = useSWR(
    wallet ? paymentsQueryKeys.walletDeposits(wallet.id) : null,
    () =>
      fetchTransfers(
        {
          pageSize: RECENT_DEPOSIT_COUNT,
          custodyWalletId: wallet?.id,
          direction: "inbound",
          includeObserved: true,
        },
        t
      ),
    { refreshInterval: DEPOSIT_POLL_MS, revalidateOnFocus: false }
  );

  if (walletsLoading && liveWallets.length === 0) {
    return <div className="h-56 animate-pulse rounded-card bg-fill-subtle" />;
  }
  if (!wallet) {
    if (liveWalletsError) {
      return <p className="text-body text-secondary">{liveWalletsError}</p>;
    }
    // Nothing to receive into yet: the design's empty state, with the way to a first wallet.
    return (
      <ListEmptyState
        message={t("DashboardPayments.depositAddress.noWalletTitle")}
        description={t("DashboardPayments.depositAddress.noWalletDescription")}
        action={
          <Button asChild>
            <Link href="/dashboard/wallets/setup">
              <PlusIcon className="size-4" aria-hidden="true" />
              {t("DashboardPayments.depositAddress.createWallet")}
            </Link>
          </Button>
        }
      />
    );
  }

  const network =
    cluster === "mainnet-beta"
      ? t("DashboardPayments.depositAddress.networkMainnet")
      : t("DashboardPayments.depositAddress.networkDevnet");
  const lastDeposit = deposits?.[0]?.createdAt;

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(wallet.publicKey);
      toast.success(t("DashboardPayments.ramps.addressCopied"), { position: "bottom-right" });
    } catch {
      toast.error(t("DashboardPayments.depositAddress.copyFailed"), { position: "bottom-right" });
    }
  };

  return (
    <div>
      <AddressCard
        wallet={wallet}
        wallets={liveWallets}
        network={network}
        onSelectWallet={setSelectedId}
        onCopy={() => void copyAddress()}
      />
      {/* 24px under the card. */}
      <DepositFacts />

      {/* The row keeps the height of the design's "Simulate a deposit" button, left out for
          now, so the line and the list under it stay where the design puts them. */}
      <div className="mt-5 flex min-h-[var(--button-height-md)] items-center">
        <p className="flex min-w-0 items-center gap-2 text-body text-secondary" aria-live="polite">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full border border-border-strong motion-safe:animate-pulse"
          />
          <span>
            {t("DashboardPayments.depositAddress.watching")}{" "}
            <span className="text-tertiary">
              {lastDeposit
                ? t("DashboardPayments.depositAddress.lastDeposit", {
                    date: formatDate(lastDeposit, locale) ?? "",
                  })
                : t("DashboardPayments.depositAddress.nothingYet")}
            </span>
          </span>
        </p>
      </div>

      <RecentDeposits
        wallet={wallet}
        deposits={deposits}
        depositsError={depositsError}
        issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
      />
    </div>
  );
}
