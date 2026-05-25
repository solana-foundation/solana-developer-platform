"use client";

import type {
  CustodyWalletAggregate,
  PaymentRampExecution,
  PaymentsWalletAggregateEnvelope,
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
import type { ComplianceSnapshot } from "./payments-workspace.types";

export type { PaymentRampExecution, PaymentRampInstruction } from "@sdp/types";

type ApiErrorBody = {
  error?: {
    message?: string;
  };
};

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

type RiskTone = "green" | "yellow" | "red" | "neutral";

export function getDevnetExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

export function getApiError(body: ApiErrorBody, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }
  return fallback;
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

function resolveRiskTone(result: ComplianceProviderResult): RiskTone {
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
  options: { signal?: AbortSignal } = {}
): Promise<WalletRecord[]> {
  const query = new URLSearchParams({
    view: "summary",
  }).toString();
  const response = await fetch(`/api/dashboard/wallets?${query}`, {
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
  data?: Array<{
    id?: string;
    type?: string;
    direction?: string;
    status?: string;
    signature?: string | null;
    source?: string;
    destination?: string;
    token?: string;
    amount?: string;
    memo?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
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

export async function fetchTransfers(
  options: { walletId?: string; signal?: AbortSignal } = {}
): Promise<TransferRecord[]> {
  const transfersQuery = new URLSearchParams({
    page: "1",
    pageSize: "20",
    ...(options.walletId ? { wallet: options.walletId } : {}),
  }).toString();
  const response = await fetch(`/api/dashboard/payments/transfers?${transfersQuery}`, {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body = (await response.json().catch(() => ({}))) as TransferListEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Transfer list request failed (${response.status}).`));
  }

  return (body.data ?? [])
    .filter((transfer): transfer is NonNullable<typeof transfer> => Boolean(transfer?.id))
    .map((transfer) => ({
      id: transfer.id ?? "",
      ...(transfer.type ? { type: transfer.type } : {}),
      ...(transfer.direction ? { direction: transfer.direction } : {}),
      status: transfer.status ?? "pending",
      signature: transfer.signature ?? null,
      ...(transfer.source ? { source: transfer.source } : {}),
      ...(transfer.destination ? { destination: transfer.destination } : {}),
      ...(transfer.token ? { token: transfer.token } : {}),
      ...(transfer.amount ? { amount: transfer.amount } : {}),
      ...(transfer.memo ? { memo: transfer.memo } : {}),
      ...(transfer.createdAt ? { createdAt: transfer.createdAt } : {}),
      ...(transfer.updatedAt ? { updatedAt: transfer.updatedAt } : {}),
    }));
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

type SandboxTransferSimulationInput = {
  provider: "lightspark";
  payload: {
    quoteId: string;
    currencyCode?: "USD";
    currencyAmount?: number;
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
