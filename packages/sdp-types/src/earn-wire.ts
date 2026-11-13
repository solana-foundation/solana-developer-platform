/** Runtime contracts shared by Treasury response parsing and the OpenAPI documents. */
import { z } from "zod";
import {
  EARN_MOVEMENT_STATUSES,
  EARN_VAULT_MOVEMENT_STATUSES,
  type EarnVaultDeposit,
  type EarnVaultDepositRecord,
  type EarnVaultWithdrawal,
} from "./earn";
import { SOLANA_CLUSTERS } from "./well-known-tokens";

// The descriptions below are the API reference's field text; they change no parsing.

export const earnBalanceReadContextSchema = z.object({
  afterMovementIds: z
    .array(z.string())
    .max(100)
    .describe("The movement IDs the read was bound to."),
  minimumSlot: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .describe("The slot those movements confirmed at. Affected balances are read at or after it."),
});

const settlementOutcome = z
  .enum(["delivered", "cancelled"])
  .optional()
  .describe(
    "For a movement the provider completes later: `delivered` once the provider settled it, or " +
      "`cancelled` when it returned the order unfilled. Absent until known."
  );
const depositStatus = z
  .enum(EARN_VAULT_MOVEMENT_STATUSES)
  .describe(
    "`pending` (recorded, not yet seen on the network), `submitted`, `confirmed` or `failed`. " +
      "`confirmed` covers finality too; the movements feed reports `finalized` separately."
  );
const providerReference = z
  .string()
  .describe(
    "The strategy's onchain address. It identifies the instrument: never send tokens to it."
  );
const failureReason = z.string().nullable().describe("Why the transaction failed; null otherwise.");

export const earnVaultDepositSchema: z.ZodType<EarnVaultDeposit> = z.object({
  positionId: z.string().describe("The position this deposit opened or added to."),
  movementId: z
    .string()
    .describe("The deposit's ID. Track it with `GET /v1/earn/vault-deposits/{movementId}`."),
  settlementOutcome,
  status: depositStatus,
  signature: z.string().describe("The deposit transaction's signature."),
  failureReason,
  replayed: z
    .boolean()
    .describe("True when this response repeats an earlier request with the same Idempotency-Key."),
  strategy: z
    .object({
      id: z.string(),
      name: z.string(),
      provider: z.string(),
      providerReference,
      hostCluster: z.enum(SOLANA_CLUSTERS),
    })
    .describe("The strategy the deposit went into."),
});

export const earnVaultDepositRecordSchema: z.ZodType<EarnVaultDepositRecord> = z.object({
  movementId: z.string(),
  settlementOutcome,
  positionId: z.string(),
  provider: z.string(),
  providerReference,
  status: depositStatus,
  signature: z.string().describe("The deposit transaction's signature."),
  amount: z.string().describe("The accepted deposit amount, in deposit-token units."),
  failureReason,
  createdAt: z.string(),
  confirmedAt: z
    .string()
    .nullable()
    .describe("When SDP observed the transaction on the network; null until then."),
});

export const earnVaultWithdrawalSchema: z.ZodType<EarnVaultWithdrawal> = z.object({
  redemptionMode: z
    .enum(["standard", "instant"])
    .optional()
    .describe("The redemption route, for a provider that offers more than one."),
  movementId: z
    .string()
    .describe("The withdrawal's ID. Track it with `GET /v1/earn/vault-withdrawals/{movementId}`."),
  settlementOutcome,
  positionId: z.string(),
  provider: z.string(),
  providerReference,
  ownerAddress: z
    .string()
    .nullable()
    .describe("Address of the custody wallet that owns the position and receives the payout."),
  status: z
    .enum(EARN_MOVEMENT_STATUSES.vault_direct)
    .describe("Only `finalized` and `failed` are final."),
  signature: z.string().describe("The withdrawal transaction's signature."),
  shares: z
    .string()
    .describe(
      "Shares the withdrawal redeems, in share units. The payout is `tokenAmount` on the movements feed."
    ),
  shareMint: z.string(),
  failureReason,
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  settledAt: z.string().nullable().describe("When the withdrawal became final; null until then."),
  replayed: z
    .boolean()
    .optional()
    .describe(
      "On the create response: true when it repeats an earlier request with the same Idempotency-Key."
    ),
});
