import { compareDecimalAmounts } from "@sdp/payments/decimal";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  isRampTransferType,
  isTerminalRampTransferStatus,
  type MoneygramRampEvent,
  type RampTransferType,
} from "@sdp/types";
import { getDb } from "@/db";
import { asTransactionalClient } from "@/db/client";
import type { PaymentTransferRow } from "@/db/repositories";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { noContent } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentsRepository, rampRuntime } from "../../context";
import { isRampQuoteBindingExpired } from "../quote-binding";
import type { coinbaseRampEventSchema, moneygramRampEventSchema } from "./schemas";

function readMoneygramData(transfer: PaymentTransferRow): Record<string, unknown> {
  const value = transfer.provider_data.moneygram;
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw internalError("Transfer provider_data.moneygram is not an object.");
  }
  return value as Record<string, unknown>;
}

async function requireVerifiedCryptoLeg(
  c: AppContext,
  ramp: PaymentTransferRow,
  cryptoTransferId: string,
  options: { requireConfirmed: boolean }
): Promise<PaymentTransferRow> {
  if (ramp.destination_address === null) {
    throw conflict("MoneyGram deposit address has not been recorded for this session.");
  }
  const leg = await getPaymentsRepository(c).getTransferById({
    transferId: cryptoTransferId,
    organizationId: ramp.organization_id,
    projectId: ramp.project_id,
  });
  if (!leg) {
    throw notFound("Transfer");
  }
  if (leg.type !== "transfer") {
    throw badRequest("cryptoTransferId must reference a wallet transfer.");
  }
  if (!ramp.source_address) {
    throw internalError("Off-ramp transfer is missing its source address.");
  }
  if (leg.source_address !== ramp.source_address) {
    throw badRequest("Crypto transfer was not sent from the off-ramp source wallet.");
  }
  if (leg.wallet_id !== ramp.wallet_id) {
    throw badRequest("Crypto transfer was not sent from the off-ramp wallet.");
  }
  if (leg.direction !== "outbound") {
    throw badRequest("Crypto transfer must be outbound.");
  }
  if (leg.destination_address !== ramp.destination_address) {
    throw badRequest("Crypto transfer was not sent to the MoneyGram deposit address.");
  }
  if (leg.token !== ramp.token) {
    throw badRequest("Crypto transfer asset does not match the off-ramp asset.");
  }
  if (ramp.amount !== null && compareDecimalAmounts(leg.amount ?? "0", ramp.amount) !== 0) {
    throw badRequest("Crypto transfer amount does not match the off-ramp amount.");
  }
  if (!leg.signature) {
    throw badRequest("Crypto transfer has no on-chain signature.");
  }
  if (options.requireConfirmed && leg.status !== "confirmed" && leg.status !== "finalized") {
    throw badRequest(`Crypto transfer is not confirmed on-chain (status: ${leg.status}).`);
  }
  return leg;
}

/**
 * Browser/widget callbacks are useful telemetry, but they are not provider-authenticated
 * settlement evidence. Keep them in an explicitly advisory namespace and never derive a
 * transfer status from them.
 */
async function recordAdvisoryClientEvent(
  c: AppContext,
  transfer: PaymentTransferRow,
  event: Record<string, unknown>
) {
  const receivedAt = new Date().toISOString();
  await getPaymentsRepository(c).updateTransfer({
    transferId: transfer.id,
    expectedStatus: transfer.status,
    providerData: { clientEvent: { ...event, advisory: true, receivedAt } },
    updatedAt: receivedAt,
  });
  return noContent(c);
}

export async function recordCoinbaseRampEvent(
  c: ValidatedBodyContext<typeof coinbaseRampEventSchema>
) {
  const event = c.req.valid("json");

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = getPaymentsRepository(c);

  const transfer = await repo.getTransferByProviderReference({
    provider: "coinbase",
    providerReference: event.orderId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!transfer) {
    throw notFound("Ramp transfer");
  }
  if (transfer.type !== "onramp") {
    throw badRequest("Coinbase events only apply to on-ramp transfers.");
  }
  if (isTerminalRampTransferStatus(transfer.status)) {
    return noContent(c);
  }

  switch (event.kind) {
    case "committed":
      return recordAdvisoryClientEvent(c, transfer, { kind: event.kind });
    case "errored":
      return recordAdvisoryClientEvent(c, transfer, {
        kind: event.kind,
        reason: event.reason,
      });
    default: {
      const exhaustive: never = event;
      throw internalError(`Unhandled Coinbase ramp event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const MONEYGRAM_EVENT_DIRECTION = {
  transaction_created: null,
  deposit_address: "offramp",
  onramp_completed: "onramp",
  signed: "offramp",
  completed: "offramp",
  errored: null,
  closed: null,
} as const satisfies Record<MoneygramRampEvent["kind"], "onramp" | "offramp" | null>;

export async function recordMoneygramRampEvent(
  c: ValidatedBodyContext<typeof moneygramRampEventSchema>
) {
  const event = c.req.valid("json");

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const repo = getPaymentsRepository(c);

  const transfer = await repo.getTransferByProviderReference({
    provider: "moneygram",
    providerReference: event.sessionId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!transfer) {
    throw notFound("Ramp transfer");
  }
  if (isTerminalRampTransferStatus(transfer.status)) {
    return noContent(c);
  }

  const expectedDirection = MONEYGRAM_EVENT_DIRECTION[event.kind];
  if (expectedDirection !== null && transfer.type !== expectedDirection) {
    throw badRequest(
      `MoneyGram ${event.kind} events only apply to ${expectedDirection} transfers.`
    );
  }

  const moneygramData = readMoneygramData(transfer);
  switch (event.kind) {
    case "transaction_created":
      return pinMoneygramTransaction(c, transfer, moneygramData, event);
    case "deposit_address":
      return pinMoneygramDeposit(c, transfer, moneygramData);
    case "signed":
      break;
    default:
      return recordMoneygramAdvisoryEvent(c, transfer, moneygramData, event);
  }
  if (transfer.status === "settling") {
    if (moneygramData.cryptoTransferId === event.cryptoTransferId) {
      return noContent(c);
    }
    throw conflict("Off-ramp transfer is already settling a different crypto transfer.");
  }
  if (transfer.status !== "pending") {
    throw conflict(`Cannot record a signed event while the transfer is ${transfer.status}.`);
  }
  // A signed event starts settlement under the widget session; once the bound
  // session has expired the transfer cannot accept a new crypto leg.
  if (isRampQuoteBindingExpired(transfer)) {
    throw conflict("MoneyGram session has expired; create a new quote before signing.");
  }
  const leg = await requireVerifiedCryptoLeg(c, transfer, event.cryptoTransferId, {
    requireConfirmed: false,
  });
  const updated = await repo.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ["pending"],
    toStatus: "settling",
    amount: leg.amount,
    providerData: {
      moneygram: {
        ...moneygramData,
        cryptoTransferId: leg.id,
        solanaTxSignature: leg.signature,
      },
    },
    updatedAt: new Date().toISOString(),
  });
  if (!updated) {
    const current = await repo.getTransferById({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
    });
    if (current?.status === "settling" && readMoneygramData(current).cryptoTransferId === leg.id) {
      return noContent(c);
    }
    throw conflict("Off-ramp transfer changed while the signed event was recorded.");
  }
  return noContent(c);
}

/**
 * Pins the Ramps transaction id the widget surfaced after validate. The id is the
 * key for every later status read, so it is first-write-wins: a replay with the
 * same id is a no-op and a different id for the same session is a conflict.
 *
 * The browser names the transaction, so before anything is pinned MoneyGram must
 * confirm under the secret key that the transaction carries this counterparty's
 * customerIdentifier and the direction of this transfer. The same read yields
 * MoneyGram's profile id, which becomes the counterparty's `customer_link`
 * reference (read back through the provider-accounts list) and is mirrored on
 * the transfer as `moneygram.customerId`.
 */
async function pinMoneygramTransaction(
  c: AppContext,
  transfer: PaymentTransferRow,
  moneygramData: Record<string, unknown>,
  event: Extract<MoneygramRampEvent, { kind: "transaction_created" }>
) {
  const customerIdentifier = transfer.counterparty_id;
  if (customerIdentifier === null) {
    throw internalError("Ramp transfer is missing its counterparty.");
  }
  const projectId = transfer.project_id;
  if (projectId === null) {
    throw internalError("Ramp transfer is missing its project.");
  }
  if (!isRampTransferType(transfer.type)) {
    throw badRequest("MoneyGram events only apply to ramp transfers.");
  }
  const linkScope = {
    organizationId: transfer.organization_id,
    projectId,
    counterpartyId: customerIdentifier,
    provider: "moneygram",
  } as const;
  if (moneygramData.transactionId !== undefined) {
    if (moneygramData.transactionId !== event.transactionId) {
      throw conflict("MoneyGram session is already bound to a different transaction.");
    }
    return noContent(c);
  }
  if (transfer.status !== "pending") {
    throw conflict(`Cannot bind a MoneyGram transaction while the transfer is ${transfer.status}.`);
  }
  if (isRampQuoteBindingExpired(transfer)) {
    throw conflict("MoneyGram session has expired; create a new quote before continuing.");
  }
  const owned = await RAMP_PROVIDER_CLIENTS.moneygram.findOwnedTransaction(rampRuntime(c), {
    transactionId: event.transactionId,
    customerIdentifier,
  });
  if (!owned) {
    throw conflict("MoneyGram transaction does not belong to this session.");
  }
  if (owned.transactionType !== MONEYGRAM_TRANSACTION_TYPE[transfer.type]) {
    throw conflict("MoneyGram transaction direction does not match this transfer.");
  }
  const customerId = owned.profileId;
  const claimed = await getDb(c.env).transaction(async (tx) => {
    const txClient = asTransactionalClient(tx);
    const row = await createPostgresPaymentsRepository(
      txClient,
      getRequestTenantScope(c)
    ).claimTransferProviderData({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      expectedStatus: "pending",
      claimPath: ["moneygram", "transactionId"],
      providerData: {
        moneygram: {
          ...moneygramData,
          customerId,
          transactionId: event.transactionId,
          ...(event.mgiTransactionId ? { mgiTransactionId: event.mgiTransactionId } : {}),
        },
      },
      updatedAt: new Date().toISOString(),
    });
    if (!row) {
      return null;
    }
    await createPostgresCounterpartyProviderAccountsRepository(txClient).upsertProviderAccount({
      ...linkScope,
      providerCustomerReference: customerId,
    });
    return row;
  });
  if (claimed) {
    return noContent(c);
  }
  const current = await getPaymentsRepository(c).getTransferById({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  });
  if (current && readMoneygramData(current).transactionId === event.transactionId) {
    return noContent(c);
  }
  throw conflict("Off-ramp transfer changed while the MoneyGram transaction was bound.");
}

const MONEYGRAM_TRANSACTION_TYPE = {
  onramp: "cash-in",
  offramp: "cash-out",
} as const satisfies Record<RampTransferType, "cash-in" | "cash-out">;

/**
 * Reads the deposit instruction for a committed custodial off-ramp from the Ramps
 * status API and writes it onto the transfer row itself: MoneyGram's deposit
 * address becomes the row's destination and its memo the row's memo, so the
 * browser funds whatever the transfer says rather than anything the widget sent.
 * The amount MoneyGram expects must equal the quoted row amount. The read is
 * side-effect free on MoneyGram's side; the spend happens later under the
 * session idempotency key when the crypto leg is sent.
 */
async function pinMoneygramDeposit(
  c: AppContext,
  transfer: PaymentTransferRow,
  moneygramData: Record<string, unknown>
) {
  if (transfer.destination_address !== null) {
    return noContent(c);
  }
  if (transfer.status !== "pending") {
    throw conflict(`Cannot read a deposit address while the transfer is ${transfer.status}.`);
  }
  if (isRampQuoteBindingExpired(transfer)) {
    throw conflict("MoneyGram session has expired; create a new quote before funding.");
  }
  const transactionId = moneygramData.transactionId;
  if (typeof transactionId !== "string") {
    throw conflict("MoneyGram transaction has not been recorded for this session.");
  }
  if (transfer.amount === null) {
    throw internalError("Off-ramp transfer is missing its crypto amount.");
  }
  const deposit = await RAMP_PROVIDER_CLIENTS.moneygram.getAwaitingDeposit(
    rampRuntime(c),
    transactionId
  );
  if (compareDecimalAmounts(deposit.sendAmount, transfer.amount) !== 0) {
    throw conflict(
      "MoneyGram expects a different amount than this off-ramp was quoted for; create a new quote."
    );
  }
  const repo = getPaymentsRepository(c);
  const updated = await repo.claimTransferDestination({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    expectedStatus: "pending",
    destinationAddress: deposit.depositAddress,
    memo: deposit.depositMemo === undefined ? null : deposit.depositMemo,
    updatedAt: new Date().toISOString(),
  });
  if (updated) {
    return noContent(c);
  }
  const current = await repo.getTransferById({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  });
  if (current && current.destination_address === deposit.depositAddress) {
    return noContent(c);
  }
  throw conflict("Off-ramp transfer changed while the deposit address was recorded.");
}

async function recordMoneygramAdvisoryEvent(
  c: AppContext,
  transfer: PaymentTransferRow,
  moneygramData: Record<string, unknown>,
  event: Exclude<MoneygramRampEvent, { kind: "signed" | "transaction_created" | "deposit_address" }>
) {
  switch (event.kind) {
    case "onramp_completed":
      return recordAdvisoryClientEvent(c, transfer, {
        kind: event.kind,
        transactionId: event.transactionId,
        amount: event.amount,
        status: event.status,
        ...(event.referenceNumber ? { referenceNumber: event.referenceNumber } : {}),
      });
    case "completed": {
      if (transfer.status !== "pending" && transfer.status !== "settling") {
        throw conflict(`Cannot record a completed event while the transfer is ${transfer.status}.`);
      }
      if (
        transfer.status === "settling" &&
        moneygramData.cryptoTransferId !== event.cryptoTransferId
      ) {
        throw conflict("Off-ramp transfer is already settling a different crypto transfer.");
      }
      const leg = await requireVerifiedCryptoLeg(c, transfer, event.cryptoTransferId, {
        requireConfirmed: true,
      });
      return recordAdvisoryClientEvent(c, transfer, {
        kind: event.kind,
        cryptoTransferId: leg.id,
        transactionId: event.transactionId,
        payoutAmount: event.payoutAmount,
        payoutStatus: event.payoutStatus,
        ...(event.referenceNumber ? { referenceNumber: event.referenceNumber } : {}),
      });
    }
    case "errored":
      return recordAdvisoryClientEvent(c, transfer, {
        kind: event.kind,
        reason: event.reason,
        ...(event.cryptoTransferId ? { cryptoTransferId: event.cryptoTransferId } : {}),
        ...(event.transactionId ? { transactionId: event.transactionId } : {}),
      });
    case "closed":
      return recordAdvisoryClientEvent(c, transfer, { kind: event.kind });
  }
}
