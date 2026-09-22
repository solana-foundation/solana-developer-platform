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
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { baseProviderAccount } from "@/routes/counterparty-provider-accounts/handlers";
import { type AppContext, getPaymentsRepository, rampRuntime } from "../../context";
import { mapTransferRow } from "../../mappers";
import type { coinbaseRampEventSchema, moneygramRampEventSchema } from "../../schemas";
import { isRampQuoteBindingExpired } from "./quote-binding";

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
  options: { requireConfirmed: boolean; depositAddress: string }
): Promise<PaymentTransferRow> {
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
  if (leg.destination_address !== options.depositAddress) {
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

function transferResponse(c: AppContext, row: PaymentTransferRow | null) {
  if (!row) {
    throw internalError("Failed to update the ramp transfer.");
  }
  return success(c, { transfer: mapTransferRow(row) });
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
  const repo = getPaymentsRepository(c);
  const receivedAt = new Date().toISOString();
  const updated = await repo.updateTransfer({
    transferId: transfer.id,
    expectedStatus: transfer.status,
    providerData: { clientEvent: { ...event, advisory: true, receivedAt } },
    updatedAt: receivedAt,
  });
  if (updated) {
    return transferResponse(c, updated);
  }
  const current = await repo.getTransferById({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  });
  return transferResponse(c, current);
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
    return success(c, { transfer: mapTransferRow(transfer) });
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
    return success(c, { transfer: mapTransferRow(transfer) });
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
      return pinMoneygramDepositAddress(c, transfer, moneygramData);
    case "signed":
      break;
    default:
      return recordMoneygramAdvisoryEvent(c, transfer, moneygramData, event);
  }
  if (transfer.status === "settling") {
    if (moneygramData.cryptoTransferId === event.cryptoTransferId) {
      return success(c, { transfer: mapTransferRow(transfer) });
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
    depositAddress: requireMoneygramDepositAddress(moneygramData),
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
      return transferResponse(c, current);
    }
    throw conflict("Off-ramp transfer changed while the signed event was recorded.");
  }
  return transferResponse(c, updated);
}

function readMoneygramDepositAddress(moneygramData: Record<string, unknown>): string | null {
  const value = moneygramData.depositAddress;
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw internalError("Transfer provider_data.moneygram.depositAddress is not a string.");
  }
  return value;
}

function requireMoneygramDepositAddress(moneygramData: Record<string, unknown>): string {
  const depositAddress = readMoneygramDepositAddress(moneygramData);
  if (depositAddress === null) {
    throw conflict("MoneyGram deposit address has not been recorded for this session.");
  }
  return depositAddress;
}

/**
 * Pins the Ramps transaction id the widget surfaced after validate. The id is the
 * key for every later status read, so it is first-write-wins: a replay with the
 * same id is a no-op and a different id for the same session is a conflict.
 *
 * The browser names the transaction, so before anything is pinned MoneyGram must
 * confirm under the secret key that the transaction carries this counterparty's
 * customerIdentifier and the direction of this transfer. The same read yields MoneyGram's profile id, which
 * becomes the counterparty's `customer_link` reference and is mirrored on the
 * transfer.
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
  const links = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
  const existingLink = await links.getProviderAccount(linkScope);
  if (moneygramData.transactionId !== undefined) {
    if (moneygramData.transactionId !== event.transactionId) {
      throw conflict("MoneyGram session is already bound to a different transaction.");
    }
    if (!existingLink) {
      throw internalError("MoneyGram customer link is missing for a bound transaction.");
    }
    return customerLinkedTransferResponse(c, transfer, existingLink);
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
    const link = await createPostgresCounterpartyProviderAccountsRepository(
      txClient
    ).upsertProviderAccount({ ...linkScope, providerCustomerReference: customerId });
    return { row, link };
  });
  if (claimed) {
    return customerLinkedTransferResponse(c, claimed.row, claimed.link);
  }
  const current = await getPaymentsRepository(c).getTransferById({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  });
  const currentLink = await links.getProviderAccount(linkScope);
  if (current && currentLink && readMoneygramData(current).transactionId === event.transactionId) {
    return customerLinkedTransferResponse(c, current, currentLink);
  }
  throw conflict("Off-ramp transfer changed while the MoneyGram transaction was bound.");
}

const MONEYGRAM_TRANSACTION_TYPE = {
  onramp: "cash-in",
  offramp: "cash-out",
} as const satisfies Record<RampTransferType, "cash-in" | "cash-out">;

function customerLinkedTransferResponse(
  c: AppContext,
  transfer: PaymentTransferRow,
  link: CounterpartyProviderAccountRow
) {
  return success(c, {
    transfer: mapTransferRow(transfer),
    customerLink: baseProviderAccount(link, link),
  });
}

/**
 * Reads the deposit instruction for a committed custodial off-ramp from the Ramps
 * status API and pins it on the transfer, so the browser signs against an address
 * and amount our server fetched under the secret key rather than the widget payload.
 * The read is side-effect free on MoneyGram's side; the spend happens later under
 * the session idempotency key when the crypto leg is sent.
 */
async function pinMoneygramDepositAddress(
  c: AppContext,
  transfer: PaymentTransferRow,
  moneygramData: Record<string, unknown>
) {
  if (readMoneygramDepositAddress(moneygramData) !== null) {
    return success(c, { transfer: mapTransferRow(transfer) });
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
  const updated = await repo.claimTransferProviderData({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    expectedStatus: "pending",
    claimPath: ["moneygram", "depositAddress"],
    providerData: { moneygram: { ...moneygramData, ...deposit } },
    updatedAt: new Date().toISOString(),
  });
  if (updated) {
    return transferResponse(c, updated);
  }
  const current = await repo.getTransferById({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  });
  if (
    current &&
    readMoneygramDepositAddress(readMoneygramData(current)) === deposit.depositAddress
  ) {
    return transferResponse(c, current);
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
        depositAddress: requireMoneygramDepositAddress(moneygramData),
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
