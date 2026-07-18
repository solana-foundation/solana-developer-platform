"use client";

import type {
  CoinbaseRampEvent,
  Counterparty,
  CounterpartyAccount,
  CounterpartyAccountSummary,
  CryptoRailId,
  CustodyWalletAggregate,
  ListCounterpartyAccountsResponse,
  MoneygramRampEvent,
  MuralSandboxPayinCurrency,
  PaymentRampEstimateEnvelope,
  PaymentsWalletAggregateEnvelope,
  PaymentTransferBatch,
  PaymentTransferBatchEnvelope,
  PaymentTransferBatchEstimate,
  PaymentTransferBatchEstimateEnvelope,
  PaymentTransferBatchRequest,
  PaymentTransferRecipient,
  RampDirection,
  RampEventProvider,
  RampFiatCurrency,
  RampProviderEstimateResult,
  RampProviderId,
  PaymentTransferEnvelope as TransferEnvelope,
  PaymentTransferSummary as TransferRecord,
  PaymentWalletPolicy as WalletPolicy,
  PaymentWalletPolicyEnvelope as WalletPolicyEnvelope,
  PaymentsDashboardWallet as WalletRecord,
  PaymentsDashboardWalletsEnvelope as WalletsEnvelope,
} from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import {
  type ComplianceIntent,
  type ComplianceProviderResult,
  screenAddressCompliance,
} from "@/lib/compliance";
import {
  type PaymentApiErrorBody as ApiErrorBody,
  getPaymentApiError as getApiError,
} from "./payment-api-errors";
import type { ComplianceSnapshot } from "./payments-workspace.types";

export type { PaymentRampInstruction } from "@sdp/types";
export { getPaymentApiError as getApiError } from "./payment-api-errors";

export interface PaymentWalletBalance {
  token: string;
  mint: string;
  amount: string;
  uiAmount: string;
  decimals: number;
}

export interface PaymentWalletBalancesSnapshot {
  walletId: string;
  address: string;
  balances: PaymentWalletBalance[];
}

export type RiskTone = "green" | "yellow" | "red" | "neutral";
type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getDevnetExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

export function toProviderLabel(value: string): string {
  const labels: Record<string, string> = {
    range: "Range",
    elliptic: "Elliptic",
    trm: "TRM",
    chainalysis: "Chainalysis",
  };
  return labels[value] ?? value.toUpperCase();
}

export function formatRiskScore(result: ComplianceProviderResult, t: Translate): string {
  if (
    typeof result.riskScore === "number" &&
    typeof result.riskLevel === "string" &&
    result.riskLevel
  ) {
    return `${result.riskScore} - ${result.riskLevel}`;
  }
  if (typeof result.riskScore === "number") {
    return String(result.riskScore);
  }
  if (
    result.provider === "trm" &&
    result.status === "ok" &&
    result.riskScore === null &&
    !result.riskLevel?.trim()
  ) {
    return t("DashboardPayments.providerRisk.noTrmAttribution");
  }
  if (result.status === "error" && typeof result.message === "string" && result.message) {
    return result.message;
  }
  if (result.status === "unavailable") {
    return t("DashboardPayments.providerRisk.unavailable");
  }
  if (result.status === "ok" && typeof result.riskLevel === "string" && result.riskLevel) {
    return result.riskLevel;
  }
  if (result.status === "error") {
    return t("DashboardPayments.providerRisk.error");
  }
  return t("DashboardPayments.providerRisk.notAvailable");
}

export function resolveRiskTone(result: ComplianceProviderResult): RiskTone {
  if (result.status !== "ok") {
    return "neutral";
  }

  if (result.provider === "elliptic" && result.riskLevel?.toLowerCase() === "check passed") {
    return "green";
  }

  if (result.provider === "trm" && result.riskScore === null && !result.riskLevel?.trim()) {
    return "green";
  }

  if (typeof result.riskScore === "number") {
    if (result.riskScore >= 7) {
      return "red";
    }
    if (result.riskScore >= 3) {
      return "yellow";
    }
    return "green";
  }

  const riskLevel = result.riskLevel?.toLowerCase() ?? "";
  if (!riskLevel) {
    return "neutral";
  }

  if (
    riskLevel.includes("severe") ||
    riskLevel.includes("high") ||
    riskLevel.includes("critical") ||
    riskLevel.includes("elevated")
  ) {
    return "red";
  }

  if (
    riskLevel.includes("medium") ||
    riskLevel.includes("moderate") ||
    riskLevel.includes("watch")
  ) {
    return "yellow";
  }

  if (
    riskLevel.includes("low") ||
    riskLevel.includes("very low") ||
    riskLevel.includes("none") ||
    riskLevel.includes("minimal")
  ) {
    return "green";
  }

  return "neutral";
}

/** Providers that flagged the address as high risk (red tone). */
export function getHighRiskProviders(snapshot: ComplianceSnapshot): ComplianceProviderResult[] {
  return snapshot.providers.filter((result) => resolveRiskTone(result) === "red");
}

export function riskToneClassName(result: ComplianceProviderResult): string {
  const tone = resolveRiskTone(result);
  if (tone === "green") {
    return "border-success-border bg-success-bg text-success";
  }
  if (tone === "yellow") {
    return "border-warning-border bg-warning-bg text-warning";
  }
  if (tone === "red") {
    return "border-destructive-border bg-destructive-bg text-destructive-strong";
  }
  return "border-border-default bg-fill-subtle text-secondary";
}

export async function fetchWallets(
  options: { signal?: AbortSignal; includeBalances?: boolean },
  t: Translate
): Promise<WalletRecord[]> {
  const query = new URLSearchParams({
    view: "summary",
    pageSize: "100",
  });
  if (options.includeBalances) {
    query.set("includeBalances", "true");
  }
  const response = await fetch(`/api/dashboard/wallets?${query.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body = (await response.json().catch(() => ({}))) as WalletsEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.walletListRequestFailed", { status: response.status })
      )
    );
  }
  if (!body.data) {
    throw new Error(t("DashboardPayments.workspace.walletListMissing"));
  }
  return body.data;
}

export async function fetchWalletAggregate(
  t: Translate,
  signal?: AbortSignal
): Promise<CustodyWalletAggregate> {
  const response = await fetch("/api/dashboard/wallets/aggregate", {
    method: "GET",
    cache: "no-store",
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as PaymentsWalletAggregateEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.walletAggregateRequestFailed", { status: response.status })
      )
    );
  }

  if (!body.data?.aggregate) {
    throw new Error(t("DashboardPayments.workspace.walletAggregateMissing"));
  }

  return body.data.aggregate;
}

export async function fetchWalletPolicy(walletId: string, t: Translate): Promise<WalletPolicy> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/policies`,
    {
      method: "GET",
      cache: "no-store",
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletPolicyEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.walletPolicyRequestFailed", { status: response.status })
      )
    );
  }

  return (
    body.data?.policy ?? {
      walletId,
      destinationAllowlist: [],
    }
  );
}

interface TransferListEnvelope {
  data?: TransferRecord[];
  error?: {
    message?: string;
  };
}

interface WalletBalancesEnvelope {
  data?:
    | {
        walletBalances?: PaymentWalletBalancesSnapshot;
      }
    | {
        walletId?: string;
        address?: string;
        balances?: PaymentWalletBalance[];
      };
  error?: {
    message?: string;
  };
}

interface SandboxTransferSimulationEnvelope {
  data?: {
    transaction?: {
      id?: string;
      status?: string;
      quoteId?: string;
    };
  };
  error?: {
    message?: string;
  };
}

function resolveWalletBalancesSnapshot(
  envelope: WalletBalancesEnvelope
): PaymentWalletBalancesSnapshot | null {
  if (
    envelope.data &&
    "walletBalances" in envelope.data &&
    envelope.data.walletBalances &&
    typeof envelope.data.walletBalances.walletId === "string"
  ) {
    return envelope.data.walletBalances;
  }

  if (
    envelope.data &&
    "walletId" in envelope.data &&
    typeof envelope.data.walletId === "string" &&
    typeof envelope.data.address === "string" &&
    Array.isArray(envelope.data.balances)
  ) {
    return {
      walletId: envelope.data.walletId,
      address: envelope.data.address,
      balances: envelope.data.balances,
    };
  }

  return null;
}

export async function fetchTransfers(
  options: {
    pageSize: number;
    walletId?: string;
    category?: "wallet" | "ramp";
    counterpartyId?: string;
    statuses?: readonly string[];
    signal?: AbortSignal;
  },
  t: Translate
): Promise<TransferRecord[]> {
  const transfersQuery = new URLSearchParams({
    page: "1",
    pageSize: String(options.pageSize),
    ...(options.walletId ? { wallet: options.walletId } : {}),
    ...(options.category ? { category: options.category } : {}),
    ...(options.counterpartyId ? { counterpartyId: options.counterpartyId } : {}),
    ...(options.statuses ? { status: options.statuses.join(",") } : {}),
  }).toString();
  const response = await fetch(`/api/dashboard/payments/transfers?${transfersQuery}`, {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body = (await response.json()) as TransferListEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.transferListRequestFailed", { status: response.status })
      )
    );
  }

  if (!body.data) {
    throw new Error(t("DashboardPayments.workspace.transferListMissing"));
  }

  return body.data;
}

export async function fetchTransferByProviderReference(
  input: {
    provider: RampProviderId;
    providerReference: string;
    signal?: AbortSignal;
  },
  t: Translate
): Promise<TransferRecord | null> {
  const transfersQuery = new URLSearchParams({
    page: "1",
    pageSize: "1",
    category: "ramp",
    provider: input.provider,
    providerReference: input.providerReference,
  }).toString();
  const response = await fetch(`/api/dashboard/payments/transfers?${transfersQuery}`, {
    method: "GET",
    cache: "no-store",
    signal: input.signal,
  });
  const body = (await response.json()) as TransferListEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.transferLookupFailed", { status: response.status })
      )
    );
  }

  if (!body.data) {
    throw new Error(t("DashboardPayments.workspace.transferLookupMissing"));
  }
  if (body.data.length > 1) {
    throw new Error(t("DashboardPayments.workspace.transferLookupMultiple"));
  }
  if (body.data.length === 0) {
    return null;
  }

  return body.data[0];
}

export async function cancelRampTransfer(
  input: {
    provider: RampProviderId;
    providerReference: string;
  },
  t: Translate
): Promise<void> {
  const response = await fetch("/api/dashboard/payments/ramps/transfers/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as ApiErrorBody;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.transferCancellationFailed", { status: response.status })
      )
    );
  }
}

export async function fetchRampEstimates(
  input: {
    direction: RampDirection;
    assetRail: CryptoRailId;
    fiatCurrency: RampFiatCurrency;
    amount: string;
    signal?: AbortSignal;
  },
  t: Translate
): Promise<RampProviderEstimateResult[]> {
  const amountField = input.direction === "onramp" ? "fiatAmount" : "cryptoAmount";
  const response = await fetch(`/api/dashboard/payments/ramps/${input.direction}/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    signal: input.signal,
    body: JSON.stringify({
      assetRail: input.assetRail,
      fiatCurrency: input.fiatCurrency,
      [amountField]: input.amount,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as PaymentRampEstimateEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.rampEstimateRequestFailed", { status: response.status })
      )
    );
  }

  const estimates = body.data?.estimates;
  if (!estimates) {
    throw new Error(t("DashboardPayments.workspace.rampEstimateMissing"));
  }

  return estimates;
}

export async function fetchWalletBalances(
  walletId: string,
  t: Translate,
  signal?: AbortSignal
): Promise<PaymentWalletBalancesSnapshot> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/balances`,
    {
      method: "GET",
      cache: "no-store",
      signal,
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletBalancesEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.walletBalancesRequestFailed", { status: response.status })
      )
    );
  }

  const snapshot = resolveWalletBalancesSnapshot(body);
  if (!snapshot) {
    throw new Error(t("DashboardPayments.workspace.walletBalancesMissing"));
  }

  return snapshot;
}

export async function updateWalletPolicy(
  walletId: string,
  policy: WalletPolicy,
  t: Translate
): Promise<WalletPolicy> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/policies`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        destinationAllowlist: policy.destinationAllowlist,
        ...(policy.maxTransferAmount ? { maxTransferAmount: policy.maxTransferAmount } : {}),
        ...(policy.maxDailyAmount ? { maxDailyAmount: policy.maxDailyAmount } : {}),
        ...(policy.defaultAction ? { defaultAction: policy.defaultAction } : {}),
        ...(policy.rules ? { rules: policy.rules } : {}),
      }),
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletPolicyEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.walletPolicyUpdateFailed", { status: response.status })
      )
    );
  }

  if (!body.data?.policy) {
    throw new Error(t("DashboardPayments.workspace.walletPolicyUpdateEmpty"));
  }

  return body.data.policy;
}

export async function createTransfer(
  input: {
    source: string;
    destination: string;
    token: string;
    amount: string;
    memo?: string;
  },
  t: Translate
): Promise<TransferRecord> {
  const response = await fetch("/api/dashboard/payments/transfers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: input.source,
      destination: input.destination,
      token: input.token,
      amount: input.amount,
      ...(input.memo ? { memo: input.memo } : {}),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as TransferEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.transferRequestFailed", { status: response.status })
      )
    );
  }

  if (!body.data?.transfer) {
    throw new Error(t("DashboardPayments.workspace.transferMissing"));
  }

  return body.data.transfer;
}

export interface BatchRecipientsPage {
  accounts: CounterpartyAccountSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export async function fetchBatchRecipients(
  input: {
    page?: number;
    pageSize?: number;
    search?: string;
    ids?: string[];
    signal?: AbortSignal;
  },
  t: Translate
): Promise<BatchRecipientsPage> {
  const query = new URLSearchParams({
    ...(input.page ? { page: String(input.page) } : {}),
    ...(input.pageSize ? { pageSize: String(input.pageSize) } : {}),
    ...(input.search ? { search: input.search } : {}),
    ...(input.ids && input.ids.length > 0 ? { ids: input.ids.join(",") } : {}),
  });
  const response = await fetch(`/api/dashboard/counterparty/accounts?${query.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal: input.signal,
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: CounterpartyAccountSummary[];
    meta?: { total: number; page: number; pageSize: number };
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.recipientListRequestFailed", { status: response.status })
      )
    );
  }
  if (!body.data || !body.meta) {
    throw new Error(t("DashboardPayments.workspace.recipientListMissing"));
  }
  return {
    accounts: body.data,
    total: body.meta.total,
    page: body.meta.page,
    pageSize: body.meta.pageSize,
  };
}

export async function estimateTransferBatch(
  input: PaymentTransferBatchRequest,
  t: Translate
): Promise<PaymentTransferBatchEstimate> {
  const response = await fetch("/api/dashboard/payments/transfers/batch/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as PaymentTransferBatchEstimateEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.batchEstimateRequestFailed", { status: response.status })
      )
    );
  }
  if (!body.data?.estimate) {
    throw new Error(t("DashboardPayments.workspace.batchEstimateMissing"));
  }
  return body.data.estimate;
}

export interface CreateTransferBatchResult {
  batch: PaymentTransferBatch;
  recipients: PaymentTransferRecipient[];
  transfers: TransferRecord[];
}

export async function createTransferBatch(
  input: PaymentTransferBatchRequest,
  t: Translate
): Promise<CreateTransferBatchResult> {
  const response = await fetch("/api/dashboard/payments/transfers/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as PaymentTransferBatchEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.batchTransferRequestFailed", { status: response.status })
      )
    );
  }
  if (!body.data?.batch || !body.data.recipients || !body.data.transfers) {
    throw new Error(t("DashboardPayments.workspace.batchTransferMissing"));
  }
  return {
    batch: body.data.batch,
    recipients: body.data.recipients,
    transfers: body.data.transfers,
  };
}

async function postRampEvent(
  provider: RampEventProvider,
  event: MoneygramRampEvent | CoinbaseRampEvent,
  t: Translate
): Promise<TransferRecord> {
  const response = await fetch(`/api/dashboard/payments/ramps/events/${provider}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  const body = (await response.json().catch(() => ({}))) as TransferEnvelope;
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.rampEventRequestFailed", {
          provider,
          status: response.status,
        })
      )
    );
  }

  if (!body.data?.transfer) {
    throw new Error(t("DashboardPayments.workspace.rampEventMissing", { provider }));
  }

  return body.data.transfer;
}

export function postMoneygramRampEvent(
  event: MoneygramRampEvent,
  t: Translate
): Promise<TransferRecord> {
  return postRampEvent("moneygram", event, t);
}

export function postCoinbaseRampEvent(
  event: CoinbaseRampEvent,
  t: Translate
): Promise<TransferRecord> {
  return postRampEvent("coinbase", event, t);
}

export async function fetchCounterpartyAccounts(
  counterpartyId: string,
  t: Translate
): Promise<CounterpartyAccount[]> {
  const response = await fetch(
    `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/accounts?pageSize=100`
  );
  const body = (await response.json().catch(() => ({}))) as {
    data?: ListCounterpartyAccountsResponse;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.counterpartyAccountsRequestFailed", {
          status: response.status,
        })
      )
    );
  }
  return body.data?.accounts ?? [];
}

type SandboxTransferSimulationInput =
  | {
      provider: "lightspark";
      payload: {
        quoteId: string;
        currencyCode?: "USD" | "USDC";
        currencyAmount?: number;
      };
    }
  | {
      provider: "bvnk";
      payload: {
        counterpartyId: string;
        amount: number;
        fiatCurrency: string;
        cryptoToken: string;
        destinationWallet: string;
      };
    }
  | {
      provider: "mural";
      payload: {
        counterpartyId: string;
        amount: number;
        fiatCurrency: MuralSandboxPayinCurrency;
      };
    };

export async function simulateSandboxTransfer(input: SandboxTransferSimulationInput, t: Translate) {
  const response = await fetch("/api/dashboard/payments/ramps/sandbox/simulate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as SandboxTransferSimulationEnvelope;

  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.sandboxSimulationRequestFailed", {
          status: response.status,
        })
      )
    );
  }

  return body.data?.transaction ?? null;
}

export async function runComplianceCheck(
  address: string,
  intent: ComplianceIntent
): Promise<ComplianceSnapshot> {
  const result = await screenAddressCompliance({
    address,
    network: "solana",
    intent,
  });

  return {
    address,
    checkedAt: result.checkedAt,
    providers: result.providers,
  };
}

const COUNTERPARTY_PAGE_SIZE = 100;
const MAX_COUNTERPARTY_PAGES = 50;

export interface CounterpartiesResult {
  ok: boolean;
  data: Counterparty[];
  error?: string;
}

export async function fetchAllCounterparties(): Promise<CounterpartiesResult> {
  const counterparties: Counterparty[] = [];

  try {
    for (let page = 1; page <= MAX_COUNTERPARTY_PAGES; page += 1) {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(COUNTERPARTY_PAGE_SIZE),
      });
      const response = await fetch(`/api/dashboard/counterparty?${query.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        return { ok: false, data: [], error: await response.text() };
      }

      const json = (await response.json()) as {
        data?: Counterparty[];
        meta?: { total: number };
      };
      if (!json.data || !json.meta) {
        throw new Error("Counterparty list response is missing data or meta.");
      }
      counterparties.push(...json.data);

      if (counterparties.length >= json.meta.total || json.data.length === 0) {
        break;
      }
    }

    return { ok: true, data: counterparties };
  } catch (error) {
    return {
      ok: false,
      data: [],
      ...(error instanceof Error ? { error: error.message } : {}),
    };
  }
}
