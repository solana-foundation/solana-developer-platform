"use client";

import {
  type ComplianceIntent,
  type ComplianceProviderResult,
  screenAddressCompliance,
} from "@/lib/compliance";
import type {
  PaymentTransferEnvelope as TransferEnvelope,
  PaymentTransferSummary as TransferRecord,
  PaymentWalletPolicy as WalletPolicy,
  PaymentWalletPolicyEnvelope as WalletPolicyEnvelope,
  PaymentsDashboardWallet as WalletRecord,
  PaymentsDashboardWalletsEnvelope as WalletsEnvelope,
} from "@sdp/types";
import type { ComplianceSnapshot } from "./payments-workspace.types";

type ApiErrorBody = {
  error?: {
    message?: string;
  };
};

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
    (!result.riskLevel || !result.riskLevel.trim())
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

export async function fetchWallets(): Promise<WalletRecord[]> {
  const response = await fetch("/api/dashboard/wallets", {
    method: "GET",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as WalletsEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Wallet list request failed (${response.status}).`));
  }
  return body.data?.wallets ?? [];
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
    status?: string;
    signature?: string | null;
  }>;
  error?: {
    message?: string;
  };
}

export async function fetchTransfers(): Promise<TransferRecord[]> {
  const transfersQuery = new URLSearchParams({
    page: "1",
    pageSize: "20",
  }).toString();
  const response = await fetch(`/api/dashboard/payments/transfers?${transfersQuery}`, {
    method: "GET",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as TransferListEnvelope;
  if (!response.ok) {
    throw new Error(getApiError(body, `Transfer list request failed (${response.status}).`));
  }

  return (body.data ?? [])
    .filter((transfer): transfer is NonNullable<typeof transfer> => Boolean(transfer?.id))
    .map((transfer) => ({
      id: transfer.id ?? "",
      status: transfer.status ?? "pending",
      signature: transfer.signature ?? null,
    }));
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
