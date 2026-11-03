import { z } from "zod";
import type { Command } from "./commands";
import { operationById } from "./contract";

type Flag = Command["flags"][string];
const textFlag = (description: string) => ({ type: "string", description }) as const;
const flags = {
  provider: textFlag("Earn provider; recorded movement filters also accept retired provider IDs"),
  label: textFlag("Program label (set at creation)"),
  allocations: textFlag("Program allocations as a JSON object; percentages are numbers"),
  "request-id": textFlag("Caller-owned UUIDv4 request key; use one key source per operation"),
  "amount-usd": textFlag("Positive USD amount as an exact decimal string"),
  asset: textFlag("Program deposit token identifier (for example usdc)"),
  "destination-address": textFlag("Exact Solana payout address"),
  "strategy-id": textFlag("Catalogue strategy ID"),
  "custody-wallet-id": textFlag("Exact SDP custody wallet record ID (id from wallets list)"),
  amount: textFlag(
    "Deposit amount as a decimal string in deposit-token or selected source-token units"
  ),
  shares: textFlag("Share quantity as an exact decimal string"),
  "min-shares-out": textFlag(
    "Explicit minimum shares out as a decimal string; obtain from a preview"
  ),
  "min-amount-out": textFlag(
    "Explicit minimum token amount out as a decimal string; obtain from a preview"
  ),
  "source-token-mint": textFlag("Source mint for an explicitly requested swap-funded deposit"),
  "swap-slippage-bps": textFlag("Swap slippage limit in integer basis points"),
  "position-id": textFlag("Tenant-scoped Earn position ID"),
  "owner-address": textFlag("External wallet owner address; required on per-owner reads"),
  "fee-payer": textFlag("Optional partner fee-payer address; the partner must also sign"),
  "transaction-id": textFlag("Exact transactionId returned by the matching build"),
  "signed-transaction": textFlag(
    "Base64 transaction signed outside the CLI; prefer --data @file.json or stdin"
  ),
  "withdrawal-request-id": textFlag("Durable asynchronous-withdrawal request ID"),
  mechanism: textFlag("Asynchronous exit mechanism selected from withdrawal options"),
  "intermediate-amount": textFlag(
    "Operator-redemption intermediate-token amount; use instead of shares"
  ),
  "discount-bps": textFlag(
    "Solver-queue discount in integer basis points; explicit zero is preserved"
  ),
  "deadline-seconds": textFlag("Solver fulfillment deadline after maturity in whole seconds"),
  page: textFlag("Page number (1-based)"),
  "page-size": textFlag("Rows per page (1–100); default stays server-owned"),
  limit: textFlag("Keyset page size (1–100); default stays server-owned"),
  before: textFlag("Opaque nextCursor from the preceding keyset page"),
  cursor: textFlag("Opaque program-deposit cursor from the preceding response"),
  settled: textFlag("true or false; settlement is provider-aware"),
  direction: textFlag("Earn movement direction"),
  status: textFlag("Status in this resource's own vocabulary"),
  "source-address": textFlag("Exact source address on recorded movements"),
  "source-kind": textFlag("Strategy source-kind filter"),
  "apy-type": textFlag("Strategy APY-type filter"),
  "liquidity-term": textFlag("Strategy liquidity-term filter"),
  cluster: textFlag(
    "Explicit catalogue cluster; browsing another cluster does not make it fundable"
  ),
  "after-movement-ids": textFlag(
    "Comma-separated confirmed movement IDs for balance freshness (up to 100)"
  ),
  "include-owner-addresses": textFlag(
    "Explicit true/false opt-in to the project's end-user address book"
  ),
  "include-positions": textFlag("true/false; true also requires --include-owner-addresses true"),
} as const satisfies Record<string, Flag>;
type FlagName = keyof typeof flags;
const page = ["page", "page-size"] as const;
const keyset = ["limit", "before"] as const;
const deposit = [
  "strategy-id",
  "custody-wallet-id",
  "amount",
  "min-shares-out",
  "source-token-mint",
  "swap-slippage-bps",
] as const;
const externalDeposit = [
  "strategy-id",
  "owner-address",
  "fee-payer",
  "amount",
  "min-shares-out",
  "source-token-mint",
  "swap-slippage-bps",
] as const;
const withdrawal = ["position-id", "shares", "min-amount-out"] as const;
const queue = [
  "position-id",
  "shares",
  "intermediate-amount",
  "mechanism",
  "discount-bps",
  "deadline-seconds",
] as const;
const submit = ["transaction-id", "signed-transaction"] as const;

function command(
  words: readonly string[],
  operationId: string,
  names: readonly FlagName[]
): Command {
  const operation = operationById(operationId);
  const commandFlags: Record<string, Flag> = Object.fromEntries(
    names.map((name) => [name, flags[name]])
  );
  if (operation.body !== null)
    commandFlags.data = textFlag(
      "Complete JSON object, @file.json, or - for stdin; use instead of body flags"
    );
  if (
    operation.parameters.some(
      (parameter) =>
        parameter.location === "header" && parameter.name.toLowerCase() === "idempotency-key"
    )
  ) {
    commandFlags["idempotency-key"] = textFlag(
      "Explicit retry-stable key; reuse with the exact payload only for the same logical operation"
    );
  }
  return { words: ["earn", ...words], operationId, flags: commandFlags };
}

export const earnCommands: readonly Command[] = [
  command(["strategies", "list"], "listEarnStrategies", [
    ...page,
    "source-kind",
    "apy-type",
    "liquidity-term",
    "cluster",
  ]),
  command(["strategies", "get"], "getEarnStrategy", []),
  command(["treasury", "movements", "list"], "listEarnMovements", [
    ...keyset,
    "direction",
    "status",
    "provider",
    "position-id",
    "source-address",
    "destination-address",
  ]),
  command(["portfolio-accounts", "list"], "listEarnPrograms", [...page, "provider"]),
  command(["portfolio-accounts", "create"], "createEarnProgram", [
    "provider",
    "label",
    "allocations",
    "request-id",
  ]),
  command(["portfolio-accounts", "get"], "getEarnProgram", []),
  command(["portfolio-accounts", "allocation", "update"], "retargetEarnProgram", [
    "allocations",
    "request-id",
  ]),
  command(["portfolio-accounts", "deposits", "list"], "listEarnProgramDeposits", ["cursor"]),
  command(["portfolio-accounts", "withdrawals", "preview"], "previewEarnProgramWithdrawal", [
    "asset",
    "amount-usd",
  ]),
  command(["portfolio-accounts", "withdrawals", "execute"], "createEarnProgramWithdrawal", [
    "asset",
    "amount-usd",
    "destination-address",
    "request-id",
  ]),
  command(["portfolio-accounts", "withdrawals", "list"], "listEarnProgramWithdrawals", [...page]),
  command(["portfolio-accounts", "withdrawals", "get"], "getEarnProgramWithdrawal", []),
  command(["deposits", "preview"], "createEarnVaultDepositPreview", ["strategy-id", "amount"]),
  command(["deposits", "execute"], "createEarnVaultDeposit", deposit),
  command(["deposits", "provider-signed", "list"], "listEarnVaultDeposits", [
    ...keyset,
    "request-id",
    "settled",
  ]),
  command(["deposits", "provider-signed", "get"], "getEarnVaultDeposit", []),
  command(["positions", "provider-signed", "list"], "listEarnVaultPositions", [
    ...keyset,
    "after-movement-ids",
  ]),
  command(
    ["positions", "provider-signed", "share-reconciliation-report", "get"],
    "getEarnVaultShareReconciliation",
    []
  ),
  command(["withdrawals", "provider-signed", "preview"], "createEarnVaultWithdrawalPreview", [
    "position-id",
    "shares",
  ]),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["withdrawals", "provider-signed", "options", "get"], "getEarnVaultWithdrawalOptions", [
    "position-id",
  ]),
  command(["withdrawals", "execute"], "createEarnVaultWithdrawal", withdrawal),
  command(["withdrawals", "provider-signed", "list"], "listEarnVaultWithdrawals", [
    ...keyset,
    "request-id",
    "settled",
  ]),
  command(["withdrawals", "provider-signed", "get"], "getEarnVaultWithdrawal", []),
  command(
    ["withdrawal-requests", "provider-signed", "preview"],
    "createEarnVaultQueuedWithdrawalPreview",
    queue
  ),
  command(["withdrawal-requests", "execute"], "createEarnVaultWithdrawalRequest", queue),
  command(["withdrawal-requests", "provider-signed", "list"], "listEarnVaultWithdrawalRequests", [
    ...keyset,
    "status",
    "settled",
  ]),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["withdrawal-requests", "provider-signed", "get"], "getEarnVaultWithdrawalRequest", []),
  // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
  command(["withdrawal-requests", "cancel", "execute"], "cancelEarnVaultWithdrawalRequest", []),
  command(["positions", "caller-signed", "list"], "listEarnExternalWalletPositions", [
    ...keyset,
    "owner-address",
  ]),
  command(
    ["positions", "caller-signed", "project-summary", "get"],
    // biome-ignore lint/security/noSecrets: canonical OpenAPI operation ID, not a credential.
    "getEarnExternalWalletPositionSummary",
    ["include-owner-addresses", "include-positions"]
  ),
  command(["movements", "caller-signed", "list"], "listEarnExternalWalletMovements", [
    ...keyset,
    "owner-address",
    "direction",
    "status",
  ]),
  command(["movements", "caller-signed", "get"], "getEarnExternalWalletMovement", []),
  command(["earnings", "caller-signed", "get"], "getEarnExternalWalletEarnings", ["owner-address"]),
  command(
    ["deposits", "build-unsigned-transaction"],
    "createEarnExternalWalletDepositTransaction",
    externalDeposit
  ),
  command(["deposits", "submit-signed-transaction"], "createEarnExternalWalletDeposit", submit),
  command(
    ["withdrawals", "caller-signed", "preview"],
    "createEarnExternalWalletWithdrawalPreview",
    ["position-id", "shares"]
  ),
  command(
    ["withdrawals", "caller-signed", "options", "get"],
    "getEarnExternalWalletWithdrawalOptions",
    ["position-id"]
  ),
  command(
    ["withdrawals", "build-unsigned-transaction"],
    "createEarnExternalWalletWithdrawalTransaction",
    [...withdrawal, "fee-payer"]
  ),
  command(
    ["withdrawals", "submit-signed-transaction"],
    "createEarnExternalWalletWithdrawal",
    submit
  ),
  command(
    ["withdrawal-requests", "caller-signed", "preview"],
    "createEarnExternalWalletQueuedWithdrawalPreview",
    queue
  ),
  command(
    ["withdrawal-requests", "build-unsigned-transaction"],
    "createEarnExternalWalletWithdrawalRequestTransaction",
    [...queue, "fee-payer"]
  ),
  command(
    ["withdrawal-requests", "submit-signed-transaction"],
    "createEarnExternalWalletWithdrawalRequest",
    submit
  ),
  command(
    ["withdrawal-requests", "caller-signed", "list"],
    "listEarnExternalWalletWithdrawalRequests",
    [...keyset, "owner-address", "status", "settled"]
  ),
  command(
    ["withdrawal-requests", "caller-signed", "get"],
    "getEarnExternalWalletWithdrawalRequest",
    []
  ),
  command(
    ["withdrawal-requests", "cancel", "build-unsigned-transaction"],
    "createEarnExternalWalletWithdrawalRequestCancelTransaction",
    ["withdrawal-request-id", "fee-payer"]
  ),
  command(
    ["withdrawal-requests", "cancel", "submit-signed-transaction"],
    "createEarnExternalWalletWithdrawalRequestCancellation",
    submit
  ),
];

export const earnOptionFields = {
  allocations: z.string().optional(),
  "request-id": z.string().optional(),
  "amount-usd": z.string().optional(),
  "strategy-id": z.string().optional(),
  shares: z.string().optional(),
  "min-shares-out": z.string().optional(),
  "min-amount-out": z.string().optional(),
  "source-token-mint": z.string().optional(),
  "swap-slippage-bps": z.coerce.number().optional(),
  "position-id": z.string().optional(),
  "owner-address": z.string().optional(),
  "fee-payer": z.string().optional(),
  "transaction-id": z.string().optional(),
  "signed-transaction": z.string().optional(),
  "withdrawal-request-id": z.string().optional(),
  mechanism: z.string().optional(),
  "intermediate-amount": z.string().optional(),
  "discount-bps": z.coerce.number().optional(),
  "deadline-seconds": z.coerce.number().optional(),
  before: z.string().optional(),
  settled: z.enum(["true", "false"]).optional(),
  "source-address": z.string().optional(),
  "source-kind": z.string().optional(),
  "apy-type": z.string().optional(),
  "liquidity-term": z.string().optional(),
  cluster: z.string().optional(),
  "after-movement-ids": z.string().optional(),
  "include-owner-addresses": z.enum(["true", "false"]).optional(),
  "include-positions": z.enum(["true", "false"]).optional(),
};

export const earnBodyFields = [
  ["provider", "provider"],
  ["label", "label"],
  ["request-id", "requestId"],
  ["asset", "token"],
  ["amount-usd", "amountUsd"],
  ["destination-address", "destinationAddress"],
  ["strategy-id", "strategyId"],
  ["custody-wallet-id", "custodyWalletId"],
  ["owner-address", "ownerAddress"],
  ["fee-payer", "feePayer"],
  ["amount", "amount"],
  ["shares", "shares"],
  ["min-shares-out", "minSharesOut"],
  ["min-amount-out", "minAmountOut"],
  ["source-token-mint", "sourceTokenMint"],
  ["swap-slippage-bps", "swapSlippageBps"],
  ["position-id", "positionId"],
  ["transaction-id", "transactionId"],
  ["signed-transaction", "signedTransaction"],
  ["withdrawal-request-id", "withdrawalRequestId"],
  ["mechanism", "mechanism"],
  ["intermediate-amount", "intermediateAmount"],
  ["discount-bps", "discountBps"],
  ["deadline-seconds", "deadlineSeconds"],
] as const;
export const earnQueryFields = [
  ["request-id", "requestId"],
  ["position-id", "positionId"],
  ["owner-address", "ownerAddress"],
  ["source-address", "sourceAddress"],
  ["destination-address", "destinationAddress"],
  ["source-kind", "sourceKind"],
  ["apy-type", "apyType"],
  ["liquidity-term", "liquidityTerm"],
  ["cluster", "cluster"],
  ["before", "before"],
  ["settled", "settled"],
  ["after-movement-ids", "afterMovementIds"],
  ["include-owner-addresses", "includeOwnerAddresses"],
  ["include-positions", "includePositions"],
] as const;
