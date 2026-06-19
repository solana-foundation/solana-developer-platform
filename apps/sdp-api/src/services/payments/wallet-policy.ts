import { parsePostgresJsonOr } from "@/db/postgres-utils";
import type {
  PaymentsRepository,
  PaymentWalletPolicyRow as WalletPolicyRow,
} from "@/db/repositories/payments.repository";
import { isDecimalString } from "@/lib/amount";
import { AppError } from "@/lib/errors";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import {
  addDecimalAmounts,
  compareDecimalAmounts,
  getUtcDayWindow,
  sumDecimalAmounts,
} from "./decimal";

export const PAYMENT_POLICY_VERSION = 1;
export const DESTINATION_ALLOWLIST_POLICY_TYPE = "destination_allowlist";
export const TRANSFER_LIMITS_POLICY_TYPE = "transfer_limits";

function parsePolicyDocument(raw: string): Record<string, unknown> | null {
  const parsed = parsePostgresJsonOr<unknown>(raw, null);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    return null;
  }

  return parsed as Record<string, unknown>;
}

function parseDestinationAllowlistPolicy(raw: string): string[] {
  const document = parsePolicyDocument(raw);
  if (!document || document.version !== PAYMENT_POLICY_VERSION) {
    return [];
  }

  const value = document.destinationAllowlist;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseTransferLimitsPolicy(raw: string): {
  maxTransferAmount?: string;
  maxDailyAmount?: string;
} {
  const document = parsePolicyDocument(raw);
  if (!document || document.version !== PAYMENT_POLICY_VERSION) {
    return {};
  }

  const payload: { maxTransferAmount?: string; maxDailyAmount?: string } = {};
  if (typeof document.maxTransferAmount === "string") {
    payload.maxTransferAmount = document.maxTransferAmount;
  }
  if (typeof document.maxDailyAmount === "string") {
    payload.maxDailyAmount = document.maxDailyAmount;
  }

  return payload;
}

export function buildWalletPolicyPayload(
  walletId: string,
  rows: WalletPolicyRow[],
  fallbackTimestamp: string
): {
  walletId: string;
  destinationAllowlist: string[];
  maxTransferAmount?: string;
  maxDailyAmount?: string;
  createdAt: string;
  updatedAt: string;
} {
  if (rows.length === 0) {
    return {
      walletId,
      destinationAllowlist: [],
      createdAt: fallbackTimestamp,
      updatedAt: fallbackTimestamp,
    };
  }

  let destinationAllowlist: string[] = [];
  let maxTransferAmount: string | undefined;
  let maxDailyAmount: string | undefined;

  for (const row of rows) {
    if (row.policy_type === DESTINATION_ALLOWLIST_POLICY_TYPE) {
      destinationAllowlist = parseDestinationAllowlistPolicy(row.policy);
      continue;
    }

    if (row.policy_type === TRANSFER_LIMITS_POLICY_TYPE) {
      const parsed = parseTransferLimitsPolicy(row.policy);
      maxTransferAmount = parsed.maxTransferAmount;
      maxDailyAmount = parsed.maxDailyAmount;
    }
  }

  const createdAt = rows.reduce(
    (earliest, row) => (row.created_at < earliest ? row.created_at : earliest),
    rows[0].created_at
  );
  const updatedAt = rows.reduce(
    (latest, row) => (row.updated_at > latest ? row.updated_at : latest),
    rows[0].updated_at
  );

  return {
    walletId,
    destinationAllowlist,
    ...(maxTransferAmount ? { maxTransferAmount } : {}),
    ...(maxDailyAmount ? { maxDailyAmount } : {}),
    createdAt,
    updatedAt,
  };
}

export async function assertWalletPolicyAllowsTransferWithRepository(
  repository: PaymentsRepository,
  input: {
    organizationId: string;
    projectId: string | null;
    wallet: CustodyWallet;
    destinationAddress?: string | null;
    enforceDestinationAllowlist?: boolean;
    enforceDailyLimit?: boolean;
    token: string;
    amount: string;
  }
): Promise<void> {
  const rows = await repository.getWalletPoliciesByCustodyWalletId(input.wallet.id);

  if (rows.length === 0) {
    return;
  }

  const policy = buildWalletPolicyPayload(input.wallet.walletId, rows, input.wallet.createdAt);

  const shouldEnforceDestinationAllowlist = input.enforceDestinationAllowlist !== false;

  if (
    shouldEnforceDestinationAllowlist &&
    policy.destinationAllowlist.length > 0 &&
    (!input.destinationAddress || !policy.destinationAllowlist.includes(input.destinationAddress))
  ) {
    throw new AppError("FORBIDDEN", "Destination address is not allowed by wallet policy");
  }

  if (policy.maxTransferAmount) {
    if (!isDecimalString(policy.maxTransferAmount)) {
      throw new AppError("INTERNAL_ERROR", "Wallet policy has invalid maxTransferAmount");
    }

    if (compareDecimalAmounts(input.amount, policy.maxTransferAmount) > 0) {
      throw new AppError("FORBIDDEN", "Transfer amount exceeds wallet policy maxTransferAmount");
    }
  }

  if (policy.maxDailyAmount && input.enforceDailyLimit !== false) {
    if (!isDecimalString(policy.maxDailyAmount)) {
      throw new AppError("INTERNAL_ERROR", "Wallet policy has invalid maxDailyAmount");
    }

    const dayWindow = getUtcDayWindow(new Date());
    const amounts = await repository.listTransferAmounts({
      organizationId: input.organizationId,
      projectId: input.projectId,
      walletId: input.wallet.walletId,
      token: input.token,
      direction: "outbound",
      statuses: ["pending", "processing", "confirmed", "finalized"],
      createdAtFrom: dayWindow.start,
      createdAtTo: dayWindow.end,
    });

    const projectedTotal = addDecimalAmounts(sumDecimalAmounts(amounts), input.amount);
    if (compareDecimalAmounts(projectedTotal, policy.maxDailyAmount) > 0) {
      throw new AppError("FORBIDDEN", "Transfer amount exceeds wallet policy maxDailyAmount");
    }
  }
}
