import type { PaymentRampQuote } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { conflict, internalError } from "@/lib/errors";
import {
  isAbandonedReservation,
  normalizeForFingerprint,
  resolveIdentityBoundIdempotencyReplay,
} from "@/lib/idempotency";
import { success } from "@/lib/response";
import type { PolicyGateExtraction } from "@/middleware/policy-gate";
import { type AppContext, getPaymentsRepository } from "../context";
import type { RampQuotePolicyResolved } from "./shared";

type RampQuoteDirection = "onramp" | "offramp";

/**
 * Canonical request fingerprint recorded beside a keyed quote's transfer row.
 *
 * Every field here changes WHAT the provider session is bound to — the tenant
 * resources, the corridor, the amounts, and the provider-specific optional
 * selectors — so a key reused with any changed input conflicts instead of
 * silently replaying the first operation. Project scoping comes from the
 * replay lookup itself (`findTransferByIdempotency` is keyed on organization
 * + project), so the environment the project resolves to needs no separate
 * entry.
 */
export function rampQuoteIdempotencyFingerprint(params: {
  direction: RampQuoteDirection;
  body: Record<string, unknown>;
  custodyWalletId: string;
  walletAddress: string;
}): string {
  const body = params.body as {
    provider: string;
    counterpartyId: string;
    assetRail: string;
    fiatCurrency?: string;
    fiatAmount?: string;
    cryptoAmount?: string;
    rampsMemo?: Record<string, string>;
    domain?: string;
    providerAccountId?: string;
    destinationCountry?: string;
  };
  return JSON.stringify(
    normalizeForFingerprint({
      scope: "ramp_quote",
      direction: params.direction,
      provider: body.provider,
      counterpartyId: body.counterpartyId,
      custodyWalletId: params.custodyWalletId,
      walletAddress: params.walletAddress,
      assetRail: body.assetRail,
      fiatCurrency: body.fiatCurrency ?? null,
      fiatAmount: body.fiatAmount ?? null,
      cryptoAmount: body.cryptoAmount ?? null,
      rampsMemo: body.rampsMemo ?? null,
      domain: body.domain ?? null,
      providerAccountId: body.providerAccountId ?? null,
      destinationCountry: body.destinationCountry ?? null,
    })
  );
}

/**
 * Reads the verbatim quote response persisted beside a keyed quote's transfer
 * row, so a retried operation can answer with the ORIGINAL provider session
 * instead of minting a second one. Returns null when no usable response is
 * stored — a row still in progress, marked failed, or written before the
 * response capture existed.
 */
export function readStoredRampQuoteResponse(row: PaymentTransferRow): PaymentRampQuote | null {
  const rampQuote = row.provider_data.rampQuote;
  if (!rampQuote || typeof rampQuote !== "object" || Array.isArray(rampQuote)) {
    return null;
  }
  const response = (rampQuote as Record<string, unknown>).response;
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    typeof (response as PaymentRampQuote).provider !== "string" ||
    typeof (response as PaymentRampQuote).id !== "string" ||
    typeof (response as PaymentRampQuote).status !== "string"
  ) {
    return null;
  }
  return response as PaymentRampQuote;
}

/** Provider-data fragment carrying the stored quote response for keyed quotes. */
export function rampQuoteResponseProviderData(quote: PaymentRampQuote): Record<string, unknown> {
  return { rampQuote: { response: quote } };
}

/**
 * The policy-gate replay finder shared by both ramp quote routes: a request
 * carrying an `Idempotency-Key` is answered from the transfer row that key
 * already claimed. A fingerprint mismatch conflicts (409) before any new
 * work; a matching row with a stored quote response replays it verbatim; a
 * matching row without one (in progress, failed, or abandoned) falls through
 * so the handler's reservation logic decides between reuse and conflict.
 */
export async function findRampQuoteIdempotentKeyReplay(
  c: AppContext,
  extraction: PolicyGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  const { scope, wallet, walletAddress } = extraction.resolved as RampQuotePolicyResolved;
  const body = extraction.body as Record<string, unknown>;
  const direction: RampQuoteDirection = "destinationCustodyWalletId" in body ? "onramp" : "offramp";
  const fingerprint = rampQuoteIdempotencyFingerprint({
    direction,
    body,
    custodyWalletId: wallet.id,
    walletAddress,
  });

  const existing = await resolveIdentityBoundIdempotencyReplay(
    () =>
      getPaymentsRepository(c).findTransferByIdempotency({
        organizationId: scope.auth.organizationId,
        projectId: scope.auth.projectId,
        idempotencyKey,
      }),
    fingerprint,
    (row) => row.type === direction && row.custody_wallet_id === wallet.id
  );
  if (!existing) {
    return null;
  }
  const stored = readStoredRampQuoteResponse(existing);
  if (!stored) {
    return null;
  }
  return success(c, { quote: stored, transferId: existing.id });
}

export interface RampQuoteReservation {
  /** The durable row guarding this keyed operation; null when replayed. */
  row: PaymentTransferRow | null;
  /** The first operation's verbatim quote when the retry is a replay. */
  replay: { quote: PaymentRampQuote; transferId: string } | null;
}

/**
 * Reserve the keyed quote's durable in-progress record BEFORE the provider
 * call, so a lost response or a crashed process can never re-drive the
 * provider: the `payment_transfers` unique index on
 * (organization, project, idempotency_key) admits exactly one row per key.
 *
 * On a claim conflict the existing row decides, in order:
 *
 * 1. fingerprint or identity mismatch → 409 — a key is never replayed
 *    against a different request;
 * 2. stored quote response → the retry is a REPLAY of the first operation
 *    (the lost-response case the dashboard's Try Again produces);
 * 3. failed row, or a pending reservation abandoned past the same window the
 *    transfers flow uses → the row is reused in place (reset to pending) and
 *    the new attempt finalizes it, so a genuine failure keeps the explicit
 *    retry working without ever minting a second row;
 * 4. anything else is a live in-progress operation → 409; the client's next
 *    retry converges to the replay above once the first attempt finishes.
 */
export async function reserveKeyedRampQuoteTransfer(
  c: AppContext,
  input: {
    idempotencyKey: string;
    idempotencyFingerprint: string;
    transferId: string;
    direction: RampQuoteDirection;
    organizationId: string;
    projectId: string;
    counterpartyId: string;
    provider: RampProviderId;
    custodyWalletId: string;
    walletId: string;
    walletAddress: string;
    assetRail: string;
    token: string;
    sourceAddress: string | null;
    destinationAddress: string | null;
    amount: string | null;
    fiatCurrency: string | null;
    fiatAmount: string | null;
    rampsMemo: Record<string, string> | undefined;
    initiatedByKeyId: string | null;
  }
): Promise<RampQuoteReservation> {
  const repository = getPaymentsRepository(c);
  let created: PaymentTransferRow | null;
  try {
    created = await repository.createTransfer({
      id: input.transferId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      custodyWalletId: input.custodyWalletId,
      walletId: input.walletId,
      counterpartyId: input.counterpartyId,
      sourceAddress: input.sourceAddress,
      destinationAddress: input.destinationAddress,
      token: input.token,
      amount: input.amount,
      memo: null,
      type: input.direction,
      direction: input.direction === "onramp" ? "inbound" : "outbound",
      status: "pending",
      provider: input.provider,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
      rampsMemo: input.rampsMemo,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: input.initiatedByKeyId,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: input.idempotencyFingerprint,
    });
  } catch (error) {
    if (!isPostgresUniqueViolation(error)) {
      throw error;
    }
    return await resolveKeyedRampQuoteReservationConflict(c, input);
  }
  if (!created) {
    throw internalError("Failed to reserve ramp quote transfer record");
  }
  return { row: created, replay: null };
}

/**
 * Decide a keyed reservation that lost the unique-index race. Shared by the
 * pre-provider reservation; the ordered resolution is documented there.
 */
async function resolveKeyedRampQuoteReservationConflict(
  c: AppContext,
  input: {
    idempotencyKey: string;
    idempotencyFingerprint: string;
    direction: RampQuoteDirection;
    organizationId: string;
    projectId: string;
    custodyWalletId: string;
  }
): Promise<RampQuoteReservation> {
  const repository = getPaymentsRepository(c);
  const existing = await repository.findTransferByIdempotency({
    organizationId: input.organizationId,
    projectId: input.projectId,
    idempotencyKey: input.idempotencyKey,
  });
  if (
    !existing ||
    existing.idempotency_fingerprint !== input.idempotencyFingerprint ||
    existing.type !== input.direction ||
    existing.custody_wallet_id !== input.custodyWalletId
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }
  const stored = readStoredRampQuoteResponse(existing);
  if (stored) {
    return { row: null, replay: { quote: stored, transferId: existing.id } };
  }
  if (existing.status === "failed" || isAbandonedReservation(existing)) {
    const reused = await repository.updateTransfer({
      transferId: existing.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: "pending",
      providerReference: null,
      deliveryMode: null,
      error: null,
      updatedAt: new Date().toISOString(),
    });
    if (!reused) {
      throw internalError("Failed to reuse ramp quote transfer record");
    }
    return { row: reused, replay: null };
  }
  throw conflict("An identical ramp quote operation is already in progress; retry shortly.");
}

/**
 * Fail a keyed quote's reserved row when its provider call throws, so the
 * durable record reflects the outcome and the client's explicit retry reuses
 * the row instead of conflicting with an in-progress-looking reservation.
 * Unkeyed quotes have no reservation to settle.
 */
export async function failReservedRampQuoteTransfer(
  c: AppContext,
  input: {
    reservedRow: PaymentTransferRow | null;
    organizationId: string;
    projectId: string;
    error: unknown;
  }
): Promise<void> {
  if (!input.reservedRow) {
    return;
  }
  await getPaymentsRepository(c).updateTransfer({
    transferId: input.reservedRow.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    status: "failed",
    error: input.error instanceof Error ? input.error.message : String(input.error),
    updatedAt: new Date().toISOString(),
  });
}
