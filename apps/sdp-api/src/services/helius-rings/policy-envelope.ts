import type { OpType, PrivateOperationInput } from "@sdp/helius-rings";
import { OP_TYPES } from "@sdp/helius-rings";
import type { CreateWalletOperationInput } from "@sdp/policy";
import type { WalletOperationActor } from "@sdp/types";

/**
 * Maps a Rings operation onto the wallet-operation policy machinery. Every
 * Rings op evaluates as `operationFamily: "transfer"` with a `rings_*`
 * operation type: a policy that gates transfers on a wallet therefore gates
 * every Rings op rooted in it, so Rings can never be an approval bypass.
 * Finer-grained rules target the individual `rings_*` types.
 */

export type RingsEnvelopeKind = `rings_${OpType}`;

export const RINGS_ENVELOPE_KINDS = OP_TYPES.map((opType): RingsEnvelopeKind => `rings_${opType}`);

export function ringsEnvelopeKind(opType: OpType): RingsEnvelopeKind {
  return `rings_${opType}`;
}

export interface BuildRingsWalletOperationInput {
  organizationId: string;
  projectId: string;
  /** The SDP custody wallet the Rings wallet is bound to. */
  custodyWalletId: string | null;
  sdpWalletId: string;
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
  operation: PrivateOperationInput;
  /** The reserved operation id, kept with the raw payload for audit. */
  operationId: string;
  intentKey: string;
}

export function buildRingsWalletOperationInput(
  input: BuildRingsWalletOperationInput
): CreateWalletOperationInput {
  const { operation } = input;
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.custodyWalletId,
    walletId: input.sdpWalletId,
    apiKeyId: input.apiKeyId,
    actor: input.actor,
    source: input.apiKeyId === null && input.actor === null ? "system" : "api",
    operationFamily: "transfer",
    operationType: ringsEnvelopeKind(operation.opType),
    asset: operation.asset?.mint ?? null,
    amount: operation.asset?.amountRaw ?? null,
    destination: operation.to ?? null,
    legs: [],
    context: {
      ringsOperationId: input.operationId,
      ringsWalletId: operation.walletId,
      // Anonymous transfers are not lower-risk than registered ones — the
      // counterparty is undisclosed, so reviewers see the mode explicitly.
      transferMode: operation.transferMode ?? null,
      zoneId: operation.zoneId ?? null,
    },
    providerExtensions: {},
    rawPayload: {
      opType: operation.opType,
      intentKey: input.intentKey,
      timelock: operation.timelock ?? null,
    },
    idempotencyKey: input.intentKey,
  };
}
