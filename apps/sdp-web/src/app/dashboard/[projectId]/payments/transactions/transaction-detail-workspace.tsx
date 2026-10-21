"use client";

import type { PaymentTransferStatus } from "@sdp/types/payments";
import type { PersistedRampProviderId } from "@sdp/types/provider-access";
import type { UnifiedTransaction } from "@sdp/types/unified-transactions";
import { Button } from "@sdp/ui/button";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
  resolveTokenByMint,
  shortenAddress,
} from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "@/app/dashboard/[projectId]/payments/payments-page.data";
import {
  formatDateTime,
  formatDecimalAmount,
  saleFiatLabel,
} from "@/app/dashboard/[projectId]/payments/payments-presentation";
import {
  RecordAmount,
  RecordColumns,
  RecordList,
  RecordLoadError,
  RecordRow,
  RecordSection,
  RecordStateBand,
} from "@/app/dashboard/[projectId]/payments/payments-record";
import { rampPhaseCopy } from "@/app/dashboard/[projectId]/payments/ramps/ramp-phase";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { PAYMENT_REQUESTS_HREF } from "@/lib/payments-routes";
import { getRampProviderLabel } from "@/lib/ramps";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { RampOpenSale, useLiveRampTransfer } from "./ramp-open-sale";
import type { PaymentTransferDetail } from "./transaction-detail.data";
import { TRANSACTION_MODULE_HREFS, walletHref } from "./transaction-module-hrefs.redesign";
import { isPaymentTransferStatus, useTransactionStatus } from "./transaction-status";

type Translate = ReturnType<typeof useTranslations>;

const INBOUND_PAYMENT_KINDS: ReadonlySet<string> = new Set([
  "deposit",
  "request_deposit",
  "onramp",
]);

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Lamports as an exact SOL decimal string ("0.000005"), without floating-point noise. */
function lamportsToSol(lamports: number): string {
  const whole = Math.floor(lamports / LAMPORTS_PER_SOL);
  const fraction = String(lamports % LAMPORTS_PER_SOL)
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** A Solana address or signature, which the page shortens and offers to copy; bank text is not. */
function isChainValue(value: string): boolean {
  return !value.includes(" ") && value.length > 20;
}

/** A payment's direction: the transfer's own when it has one, else read from its kind. */
function paymentDirection(
  transaction: UnifiedTransaction,
  transfer: PaymentTransferDetail | null
): "inbound" | "outbound" | null {
  if (transaction.module !== "payments") return null;
  if (transfer?.direction === "inbound" || transfer?.direction === "outbound") {
    return transfer.direction;
  }
  return INBOUND_PAYMENT_KINDS.has(transaction.kind) ? "inbound" : "outbound";
}

/**
 * Why a payment is in its state, in the design's words; a ramp reads from its phase instead. A
 * failure carries the API's own reason when it gave one.
 */
function paymentWhy(
  status: PaymentTransferStatus,
  transfer: PaymentTransferDetail | null,
  t: Translate
): string {
  switch (status) {
    case "processing":
      return t("DashboardPayments.transactionDetail.why.processing");
    case "settling":
      return t("DashboardPayments.transactionDetail.why.settling");
    case "completed":
      return t("DashboardPayments.transactionDetail.why.completed");
    case "failed":
      return transfer?.error?.trim() || t("DashboardPayments.transactionDetail.why.failed");
    case "awaiting_payment":
      return t("DashboardPayments.transactionDetail.why.awaitingPayment");
    default:
      return t(`DashboardPayments.transactionDetail.why.${status}` as MessageKey);
  }
}

/** "k=v, k2=v2" for a ramp's key-value memo; the plain memo when there is one. */
function memoText(transfer: PaymentTransferDetail | null): string | null {
  if (!transfer) return null;
  if (transfer.memo?.trim()) return transfer.memo;
  const entries = Object.entries(transfer.rampsMemo ?? {});
  return entries.length === 0 ? null : entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

/** A chain value shortened with a copy of the whole; anything else as it reads. */
function chainRow(label: string, value: string): ReactNode {
  return isChainValue(value) ? (
    <RecordRow label={label} copy={value}>
      <span className="tabular-nums">{shortenAddress(value)}</span>
    </RecordRow>
  ) : (
    <RecordRow label={label}>{value}</RecordRow>
  );
}

/** What the page says about a transaction before its rows: title, state, amount, parties. */
/** The amount with its token's name, or null when the row carries no amount. */
function transactionAmountLabel(
  transaction: UnifiedTransaction,
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>,
  locale: string
): { amount: string | null; token: string | null } {
  const token =
    transaction.token === null
      ? null
      : resolveTokenByMint(transaction.token, issuedTokensByMint).tokenName;
  const amount =
    transaction.amount === null
      ? null
      : `${formatDecimalAmount(transaction.amount, locale)}${token ? ` ${token}` : ""}`;
  return { amount, token };
}

/**
 * Who the other side is. The transfer names its contact; a ledger row only carries the id,
 * which the project's contacts resolve, and the shortened id is the last resort. Without a
 * contact at all, the party is the address on the other side.
 */
function transactionParty(
  transaction: UnifiedTransaction,
  transfer: PaymentTransferDetail | null,
  direction: "inbound" | "outbound" | null,
  counterpartyName: string | null
): { contact: string | null; party: string | null } {
  const contact =
    transfer?.counterpartyDisplayName ??
    counterpartyName ??
    (transaction.counterpartyId ? shortenAddress(transaction.counterpartyId) : null);
  const counterAddress = direction === "inbound" ? transfer?.source : transfer?.destination;
  const party = contact ?? (counterAddress ? shortenAddress(counterAddress) : null);
  return { contact, party };
}

function useTransactionSummary(
  transaction: UnifiedTransaction,
  transfer: PaymentTransferDetail | null,
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>,
  counterpartyName: string | null
) {
  const t = useTranslations();
  const locale = useLocale();
  const ledgerStatus = useTransactionStatus()(transaction);
  const { amount: cryptoAmount, token } = transactionAmountLabel(
    transaction,
    issuedTokensByMint,
    locale
  );
  // A sale moves crypto to the provider, but the contact gets fiat: name what they get.
  const saleFiat = transfer?.type === "offramp" ? saleFiatLabel(transfer, locale) : null;
  const amount = saleFiat ?? cryptoAmount;
  const direction = paymentDirection(transaction, transfer);
  const { contact, party } = transactionParty(transaction, transfer, direction, counterpartyName);
  const titleKey =
    direction === "inbound"
      ? "DashboardPayments.transactionDetail.titleFrom"
      : "DashboardPayments.transactionDetail.titleTo";
  const title = amount && party ? t(titleKey, { amount, party }) : (amount ?? transaction.id);
  // A ramp reads from its whole transfer, so a held delivery or a reported payout says so.
  const ramp =
    transfer && (transfer.type === "onramp" || transfer.type === "offramp")
      ? rampPhaseCopy(t, transfer, { tokenLabel: token, locale })
      : null;
  const status =
    ramp?.kind === "needs_review"
      ? { label: t("DashboardPayments.ramps.phase.review.badge"), tone: "attention" as const }
      : ledgerStatus;
  const paymentStatus =
    transaction.module === "payments" && isPaymentTransferStatus(transaction.moduleStatus)
      ? transaction.moduleStatus
      : null;
  // A ramp's phase says why; any other payment, its status.
  const why =
    ramp?.description ??
    (paymentStatus === null ? undefined : paymentWhy(paymentStatus, transfer, t));
  const soldCrypto = saleFiat ? cryptoAmount : null;
  return { status, amount, soldCrypto, direction, contact, title, why };
}

/** A payment request's deposit waits on its payer; a ramp waits on its provider instead. */
function awaitsRequestPayment(transaction: UnifiedTransaction): boolean {
  return (
    transaction.moduleStatus === "awaiting_payment" &&
    transaction.kind !== "onramp" &&
    transaction.kind !== "offramp"
  );
}

/** Whether the band has anything to offer: the explorer, the wallet, Requests, the module. */
function hasTransactionAction(transaction: UnifiedTransaction): boolean {
  return (
    transaction.signature !== null ||
    (transaction.moduleStatus === "failed" && transaction.custodyWalletId !== null) ||
    awaitsRequestPayment(transaction) ||
    transaction.module !== "payments"
  );
}

/** The band's actions: the design's outline buttons, 30px, at its end. */
function TransactionActions({ transaction }: { transaction: UnifiedTransaction }) {
  const t = useTranslations();
  const href = useProjectHref();
  const cluster = useSolanaCluster();
  const moduleName = t(
    `DashboardPayments.transactions.modules.${transaction.module}` as MessageKey
  );
  return (
    <>
      {transaction.signature ? (
        <Button asChild variant="outline" size="sm">
          <a href={explorerTxUrl(transaction.signature, cluster)} target="_blank" rel="noreferrer">
            {t("DashboardPayments.transactionDetail.viewOnExplorer")}
            <ExternalLinkIcon aria-hidden="true" />
          </a>
        </Button>
      ) : null}
      {transaction.moduleStatus === "failed" && transaction.custodyWalletId ? (
        <Button asChild variant="outline" size="sm">
          <Link href={href(walletHref(transaction.custodyWalletId))}>
            {t("DashboardPayments.transactionDetail.openWallet")}
          </Link>
        </Button>
      ) : null}
      {awaitsRequestPayment(transaction) ? (
        <Button asChild variant="outline" size="sm">
          <Link href={href(PAYMENT_REQUESTS_HREF)}>
            {t("DashboardPayments.transactionDetail.openRequests")}
          </Link>
        </Button>
      ) : null}
      {transaction.module === "payments" ? null : (
        <Button asChild variant="outline" size="sm">
          <Link href={href(TRANSACTION_MODULE_HREFS[transaction.module](transaction.moduleId))}>
            {t("DashboardPayments.transactions.viewInModule", { module: moduleName })}
          </Link>
        </Button>
      )}
    </>
  );
}

/** The fee the wallet paid, in SOL; "None charged" at zero; said plainly when it is not known. */
function NetworkFee({ fee }: { fee: number | null | undefined }) {
  const t = useTranslations();
  const locale = useLocale();
  if (typeof fee !== "number") {
    return (
      <span className="text-tertiary">{t("DashboardPayments.transactionDetail.notRecorded")}</span>
    );
  }
  return fee === 0
    ? t("DashboardPayments.transactionDetail.noneCharged")
    : `${formatDecimalAmount(lamportsToSol(fee), locale)} SOL`;
}

/** The record's two columns: how it moved (direction, fee, source, memo) and between whom. */
/** The wallet a transaction moved through: its label, else its shortened id. */
function walletLabelOf(transaction: UnifiedTransaction): string | null {
  return transaction.custodyWalletId === null
    ? null
    : (transaction.custodyWalletLabel ?? shortenAddress(transaction.custodyWalletId));
}

function TransactionParties({
  transaction,
  transfer,
  direction,
  contact,
}: {
  transaction: UnifiedTransaction;
  transfer: PaymentTransferDetail | null;
  direction: "inbound" | "outbound" | null;
  contact: string | null;
}) {
  const t = useTranslations();
  const wallet = walletLabelOf(transaction);
  const memo = memoText(transfer);
  return (
    <RecordColumns>
      <RecordList>
        {direction ? (
          <RecordRow label={t("DashboardPayments.transactionDetail.direction")}>
            {direction === "inbound"
              ? t("DashboardPayments.transactionDetail.inbound")
              : t("DashboardPayments.transactionDetail.outbound")}
          </RecordRow>
        ) : (
          <RecordRow label={t("DashboardPayments.transactions.module")}>
            {t(`DashboardPayments.transactions.modules.${transaction.module}` as MessageKey)}
          </RecordRow>
        )}
        {transaction.module === "payments" ? (
          <RecordRow label={t("DashboardPayments.transactionDetail.networkFee")}>
            <NetworkFee fee={transfer?.fee} />
          </RecordRow>
        ) : null}
        {transfer?.source
          ? chainRow(t("DashboardPayments.transactionDetail.source"), transfer.source)
          : null}
        {memo ? (
          <RecordRow label={t("DashboardPayments.transactionDetail.memo")}>{memo}</RecordRow>
        ) : null}
      </RecordList>
      <RecordList>
        {contact ? (
          <RecordRow label={t("DashboardPayments.transactions.contact")}>{contact}</RecordRow>
        ) : null}
        {wallet ? (
          <RecordRow label={t("DashboardPayments.transactions.wallet")}>{wallet}</RecordRow>
        ) : null}
        {transfer?.destination
          ? chainRow(t("DashboardPayments.transactionDetail.destination"), transfer.destination)
          : null}
      </RecordList>
    </RecordColumns>
  );
}

/** The ramp provider that handled the payment and its own id for it. */
function ProviderSection({
  provider,
  reference,
}: {
  provider: PersistedRampProviderId;
  reference: string | undefined;
}) {
  const t = useTranslations();
  return (
    <RecordSection title={t("DashboardPayments.transactionDetail.provider")}>
      <RecordColumns>
        <RecordList>
          <RecordRow label={t("DashboardPayments.transactionDetail.handledBy")}>
            {getRampProviderLabel(provider)}
          </RecordRow>
        </RecordList>
        <RecordList>
          {reference ? (
            <RecordRow label={t("DashboardPayments.transactionDetail.theirTransferId")}>
              <span className="tabular-nums">{reference}</span>
            </RecordRow>
          ) : null}
        </RecordList>
      </RecordColumns>
    </RecordSection>
  );
}

/** What proves the transaction happened: its signature and id, the network, and its times. */
function ProofSection({
  transaction,
  updatedAt,
}: {
  transaction: UnifiedTransaction;
  updatedAt: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = useSolanaCluster();
  return (
    <RecordSection title={t("DashboardPayments.transactionDetail.proof")}>
      <RecordColumns>
        <RecordList>
          {transaction.signature ? (
            <RecordRow
              label={t("DashboardPayments.transactions.signature")}
              copy={transaction.signature}
            >
              <span className="tabular-nums">{shortenAddress(transaction.signature)}</span>
            </RecordRow>
          ) : null}
          <RecordRow
            label={t("DashboardPayments.transactionDetail.sdpTransactionId")}
            copy={transaction.id}
          >
            <span className="tabular-nums">{transaction.id}</span>
          </RecordRow>
        </RecordList>
        <RecordList>
          <RecordRow label={t("DashboardPayments.transactionDetail.network")}>
            {cluster === "mainnet-beta"
              ? t("DashboardPayments.transactionDetail.mainnet")
              : t("DashboardPayments.transactionDetail.devnet")}
          </RecordRow>
          <RecordRow label={t("DashboardPayments.transactions.created")}>
            {formatDateTime(transaction.createdAt, locale) ?? transaction.createdAt}
          </RecordRow>
          {updatedAt ? (
            <RecordRow label={t("DashboardPayments.transactionDetail.updated")}>
              {formatDateTime(updatedAt, locale) ?? updatedAt}
            </RecordRow>
          ) : null}
        </RecordList>
      </RecordColumns>
    </RecordSection>
  );
}

interface TransactionDetailWorkspaceProps {
  transaction: UnifiedTransaction | null;
  transfer: PaymentTransferDetail | null;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  /** Set when the ledger could not be read; the page says so and offers a retry. */
  error?: string;
  /** The contact's name from the project's contacts, when the row carries only its id. */
  counterpartyName?: string | null;
}

/**
 * One transaction as the design's record: titled with what moved and between whom, its state
 * and what to do about it, the amount, the parties and wallet, the provider that handled a
 * ramp, and the proof (signature, id, network, times).
 */
export function TransactionDetailWorkspace({
  transaction,
  transfer,
  issuedTokensByMint,
  counterpartyName = null,
  error,
}: TransactionDetailWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();

  if (!transaction) {
    return (
      <DashboardWorkspaceOverviewPanel>
        <RecordLoadError
          title={t("DashboardPayments.transactionDetail.loadFailedTitle")}
          description={error ?? t("DashboardPayments.transactionDetail.loadFailedDescription")}
          onRetry={() => router.refresh()}
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }
  return (
    <TransactionRecord
      transaction={transaction}
      transfer={transfer}
      issuedTokensByMint={issuedTokensByMint}
      counterpartyName={counterpartyName}
    />
  );
}

function TransactionRecord({
  transaction: initialTransaction,
  transfer: initialTransfer,
  issuedTokensByMint,
  counterpartyName = null,
}: {
  transaction: UnifiedTransaction;
  transfer: PaymentTransferDetail | null;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  /** The contact's name from the project's contacts, when the row carries only its id. */
  counterpartyName?: string | null;
}) {
  const t = useTranslations();
  const liveTransfer = useLiveRampTransfer(initialTransfer);
  const transfer = liveTransfer;
  // A live ramp's state replaces the server's snapshot of it.
  const transaction: UnifiedTransaction =
    initialTransaction.module === "payments" &&
    liveTransfer &&
    (liveTransfer.type === "onramp" || liveTransfer.type === "offramp")
      ? {
          ...initialTransaction,
          moduleStatus: liveTransfer.status,
          signature: liveTransfer.signature,
        }
      : initialTransaction;
  const summary = useTransactionSummary(
    transaction,
    transfer,
    issuedTokensByMint,
    counterpartyName
  );
  const updatedAt =
    transfer?.updatedAt && transfer.updatedAt !== transaction.createdAt ? transfer.updatedAt : null;

  return (
    <DashboardWorkspaceOverviewPanel>
      <DashboardPageTitle title={summary.title} />
      {/* The design's 32px between blocks; a titled section adds its own 22 above, 54 from the
          last row to its heading. The band sits 4px nearer the title than a page's first block
          does. */}
      <div className="-mt-1 flex flex-col gap-8" data-transaction-detail>
        <RecordStateBand
          state={summary.status.label}
          tone={summary.status.tone}
          why={summary.why}
          action={
            hasTransactionAction(transaction) ? (
              <TransactionActions transaction={transaction} />
            ) : undefined
          }
        />
        {transfer ? (
          <RampOpenSale transfer={transfer} walletLabel={walletLabelOf(transaction)} />
        ) : null}
        <RecordAmount
          label={t("DashboardPayments.transactions.amount")}
          muted={summary.amount === null}
        >
          {summary.amount ?? t("DashboardPayments.transactionDetail.notRecorded")}
          {summary.soldCrypto ? (
            <span className="ml-2 text-body font-normal text-tertiary">
              {t("DashboardPayments.transactionDetail.saleOf", { amount: summary.soldCrypto })}
            </span>
          ) : null}
        </RecordAmount>
        <TransactionParties
          transaction={transaction}
          transfer={transfer}
          direction={summary.direction}
          contact={summary.contact}
        />
        {transfer?.provider ? (
          <ProviderSection provider={transfer.provider} reference={transfer.providerReference} />
        ) : null}
        <ProofSection transaction={transaction} updatedAt={updatedAt} />
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}
