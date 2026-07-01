"use client";

import type {
  Counterparty,
  CounterpartyAccount,
  CryptoRailId,
  CustodyWalletAggregate,
  ListCounterpartiesResponse,
  ListCounterpartyAccountsResponse,
  MoneygramRampEvent,
  PaymentRampEstimateEnvelope,
  PaymentRampExecution,
  PaymentsWalletAggregateEnvelope,
  RampDirection,
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

export type { PaymentRampExecution, PaymentRampInstruction } from "@sdp/types";
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

export function formatRiskScore(result: ComplianceProviderResult): string {
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
    return "No TRM attribution";
  }
  if (result.status === "error" && typeof result.message === "string" && result.message) {
    return result.message;
  }
  if (result.status === "unavailable") {
    return "Unavailable";
  }
  if (result.status === "ok" && typeof result.riskLevel === "string" && result.riskLevel) {
    return result.riskLevel;
  }
  if (result.status === "error") {
    return "Error";
  }
  return "N/A";
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
    return "border-[rgba(17,94,61,0.18)] bg-[rgba(16,185,129,0.1)] text-[#115e3d]";
  }
  if (tone === "yellow") {
    return "border-[rgba(180,83,9,0.22)] bg-[rgba(245,158,11,0.12)] text-[#8a5a00]";
  }
  if (tone === "red") {
    return "border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.08)] text-[#9e2b38]";
  }
  return "border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.05)] text-[rgba(28,28,29,0.72)]";
}

export async function fetchWallets(
  options: { signal?: AbortSignal; includeBalances?: boolean } = {}
): Promise<WalletRecord[]> {
  const query = new URLSearchParams({
    view: "summary",
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
    throw new Error(getApiError(body, `Wallet list request failed (${response.status}).`));
  }
  return body.data?.wallets ?? [];
}

export async function fetchWalletAggregate(signal?: AbortSignal): Promise<CustodyWalletAggregate> {
  const response = await fetch("/api/dashboard/wallets/aggregate", {
    method: "GET",
    cache: "no-store",
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as PaymentsWalletAggregateEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet aggregate request failed (${response.status}).`));
  }

  if (!body.data?.aggregate) {
    throw new Error("Wallet aggregate response is missing aggregate details.");
  }

  return body.data.aggregate;
}

export async function fetchWalletPolicy(walletId: string): Promise<WalletPolicy> {
  const response = await fetch(
    `/api/dashboard/payments/wallets/${encodeURIComponent(walletId)}/policies`,
    {
      method: "GET",
      cache: "no-store",
    }
  );
  const body = (await response.json().catch(() => ({}))) as WalletPolicyEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet policy request failed (${response.status}).`));
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

interface RampExecutionEnvelope {
  data?: {
    ramp?: PaymentRampExecution;
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

export async function fetchTransfers(options: {
  pageSize: number;
  walletId?: string;
  category?: "wallet" | "ramp";
  counterpartyId?: string;
  statuses?: readonly string[];
  signal?: AbortSignal;
}): Promise<TransferRecord[]> {
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
    throw new Error(getApiError(body, `Transfer list request failed (${response.status}).`));
  }

  if (!body.data) {
    throw new Error("Transfer list response is missing transfer data.");
  }

  return body.data;
}

export async function fetchTransferByProviderReference(input: {
  provider: RampProviderId;
  providerReference: string;
  signal?: AbortSignal;
}): Promise<TransferRecord | null> {
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
    throw new Error(getApiError(body, `Transfer lookup failed (${response.status}).`));
  }

  if (!body.data) {
    throw new Error("Transfer lookup response is missing transfer data.");
  }
  if (body.data.length > 1) {
    throw new Error("Transfer lookup returned multiple transfers.");
  }
  if (body.data.length === 0) {
    return null;
  }

  return body.data[0];
}

export async function cancelRampTransfer(input: {
  provider: RampProviderId;
  providerReference: string;
}): Promise<void> {
  const response = await fetch("/api/dashboard/payments/ramps/transfers/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as ApiErrorBody;
  if (!response.ok) {
    throw new Error(getApiError(body, `Transfer cancellation failed (${response.status}).`));
  }
}

export async function fetchRampEstimates(input: {
  direction: RampDirection;
  assetRail: CryptoRailId;
  fiatCurrency: RampFiatCurrency;
  amount: string;
  signal?: AbortSignal;
}): Promise<RampProviderEstimateResult[]> {
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
    throw new Error(getApiError(body, `Ramp estimate request failed (${response.status}).`));
  }

  const estimates = body.data?.estimates;
  if (!estimates) {
    throw new Error("Ramp estimate response is missing estimates.");
  }

  return estimates;
}

export async function fetchWalletBalances(
  walletId: string,
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
    throw new Error(getApiError(body, `Wallet balances request failed (${response.status}).`));
  }

  const snapshot = resolveWalletBalancesSnapshot(body);
  if (!snapshot) {
    throw new Error("Wallet balances response is missing balance details.");
  }

  return snapshot;
}

export async function updateWalletPolicy(
  walletId: string,
  policy: WalletPolicy
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
    throw new Error(getApiError(body, `Wallet policy update failed (${response.status}).`));
  }

  if (!body.data?.policy) {
    throw new Error("Wallet policy update returned an empty response.");
  }

  return body.data.policy;
}

export async function createTransfer(input: {
  source: string;
  destination: string;
  token: string;
  amount: string;
  memo?: string;
}): Promise<TransferRecord> {
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
    throw new Error(getApiError(body, `Transfer request failed (${response.status}).`));
  }

  if (!body.data?.transfer) {
    throw new Error("Transfer response is missing transfer details.");
  }

  return body.data.transfer;
}

export async function postMoneygramRampEvent(event: MoneygramRampEvent): Promise<TransferRecord> {
  const response = await fetch("/api/dashboard/payments/ramps/moneygram/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  const body = (await response.json().catch(() => ({}))) as TransferEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `MoneyGram event request failed (${response.status}).`));
  }

  if (!body.data?.transfer) {
    throw new Error("MoneyGram event response is missing transfer details.");
  }

  return body.data.transfer;
}

export async function fetchCounterpartyAccounts(
  counterpartyId: string
): Promise<CounterpartyAccount[]> {
  const response = await fetch(
    `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/accounts?pageSize=100`
  );
  const body = (await response.json().catch(() => ({}))) as {
    data?: ListCounterpartyAccountsResponse;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(getApiError(body, `Failed to load accounts (${response.status}).`));
  }
  return body.data?.accounts ?? [];
}

export async function executeRampFlow(
  direction: "onramp" | "offramp",
  payload: Record<string, unknown>
): Promise<PaymentRampExecution> {
  const response = await fetch(`/api/dashboard/payments/ramps/${direction}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as RampExecutionEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, `Ramp request failed (${response.status}).`));
  }

  if (!body.data?.ramp) {
    throw new Error("Ramp response is missing execution details.");
  }

  return body.data.ramp;
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
    };

export async function simulateSandboxTransfer(input: SandboxTransferSimulationInput) {
  const response = await fetch("/api/dashboard/payments/ramps/sandbox/simulate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => ({}))) as SandboxTransferSimulationEnvelope;

  if (!response.ok) {
    throw new Error(getApiError(body, `Sandbox simulation failed (${response.status}).`));
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

      const json = (await response.json()) as { data?: ListCounterpartiesResponse };
      const list = json.data;
      counterparties.push(...(list?.counterparties ?? []));

      const total = list?.total ?? counterparties.length;
      if (counterparties.length >= total || (list?.counterparties.length ?? 0) === 0) {
        break;
      }
    }

    return { ok: true, data: counterparties };
  } catch (error) {
    return {
      ok: false,
      data: [],
      error: error instanceof Error ? error.message : "Unable to load counterparties",
    };
  }
}
