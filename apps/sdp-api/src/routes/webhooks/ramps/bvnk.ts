import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { createCounterpartiesRepository, createPaymentsRepository } from "@/db/repositories";
import type {
  CounterpartiesRepository,
  CounterpartyRow,
} from "@/db/repositories/counterparty.repository";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  type BvnkWebhookEvent,
  findBvnkWalletEntryKey,
  isBvnkCustomerVerified,
  readBvnkCustomer,
  readBvnkOnrampEntry,
} from "@/lib/ramps/providers/bvnk";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

async function completeBvnkOnrampTransfer(
  c: AppContext,
  event: Extract<BvnkWebhookEvent, { kind: "payment" }>
): Promise<void> {
  if (event.status !== "COMPLETE" || !event.customerId || !event.walletId) {
    return;
  }
  const repo = createCounterpartiesRepository(c.env);
  const counterparty = await repo.findCounterpartyByBvnkCustomerReference(event.customerId);
  if (!counterparty) {
    return;
  }
  const entryKey = findBvnkWalletEntryKey(counterparty.provider_data, event.walletId);
  if (!entryKey) {
    return;
  }
  const ruleId = readBvnkOnrampEntry(counterparty.provider_data, entryKey).ruleId;
  if (!ruleId) {
    return;
  }
  const paymentsRepo = createPaymentsRepository(c.env);
  const transfer = await paymentsRepo.getTransferByProviderReference({
    provider: "bvnk",
    providerReference: ruleId,
  });
  if (!transfer) {
    return;
  }
  await paymentsRepo.updateTransfer({
    transferId: transfer.id,
    status: "completed",
    updatedAt: new Date().toISOString(),
  });
}

async function patchBvnkCustomerFromWebhook(
  c: AppContext,
  environment: SdpEnvironment,
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  customerReference: string,
  event: Extract<BvnkWebhookEvent, { kind: "customer" }>
): Promise<void> {
  const current = readBvnkCustomer(counterparty.provider_data);
  const customer: Record<string, unknown> = {};
  if (event.customerStatus) customer.status = event.customerStatus.toUpperCase();
  if (event.verificationUrl) customer.verificationUrl = event.verificationUrl;
  const nextStatus = typeof customer.status === "string" ? customer.status : current.status;
  const nextUrl =
    typeof customer.verificationUrl === "string"
      ? customer.verificationUrl
      : current.verificationUrl;
  if (!nextUrl && !isBvnkCustomerVerified(nextStatus)) {
    const latest = await RAMP_PROVIDER_CLIENTS.bvnk.getBvnkCustomer(
      { env: c.env as unknown as Record<string, string | undefined>, mode: environment },
      { reference: customerReference }
    );
    customer.status = latest.status.toUpperCase();
    customer.verificationStatus = latest.verificationStatus;
    if (latest.verificationUrl) customer.verificationUrl = latest.verificationUrl;
  }
  if (Object.keys(customer).length === 0) {
    return;
  }
  await repo.patchBvnkCustomerByReference({ customerReference, customer });
}

async function patchBvnkWalletFromWebhook(
  repo: CounterpartiesRepository,
  counterparty: CounterpartyRow,
  customerReference: string,
  event: Extract<BvnkWebhookEvent, { kind: "wallet" }>
): Promise<void> {
  if (!event.walletId) {
    return;
  }

  const bankAccount = event.bankAccount;
  const hasBankAccountNumber =
    bankAccount &&
    typeof bankAccount.accountNumber === "string" &&
    bankAccount.accountNumber.length > 0;
  if (!event.walletStatus && !hasBankAccountNumber) {
    return;
  }

  const key = findBvnkWalletEntryKey(counterparty.provider_data, event.walletId);
  if (!key) {
    return;
  }
  const wallet: Record<string, unknown> = {};
  if (event.walletStatus) wallet.walletStatus = event.walletStatus;
  if (hasBankAccountNumber) wallet.bankAccount = bankAccount;
  await repo.patchBvnkWalletByReference({ customerReference, walletKey: key, wallet });
}

async function processBvnkCustomerWebhook(
  c: AppContext,
  environment: SdpEnvironment,
  payload: unknown
): Promise<void> {
  const event = RAMP_PROVIDER_CLIENTS.bvnk.parseBvnkWebhookEvent(payload);
  if (event.kind === "ignore") {
    console.log(`[bvnk webhook] unmapped event "${event.event}": ${JSON.stringify(payload)}`);
    return;
  }

  if (event.kind === "payment") {
    return completeBvnkOnrampTransfer(c, event);
  }

  if (!event.customerReference) {
    console.log(
      `[bvnk webhook] "${event.event}" has no customer reference: ${JSON.stringify(payload)}`
    );
    return;
  }

  const repo = createCounterpartiesRepository(c.env);
  const counterparty = await repo.findCounterpartyByBvnkCustomerReference(event.customerReference);
  if (!counterparty) {
    return;
  }

  if (event.kind === "customer") {
    return patchBvnkCustomerFromWebhook(
      c,
      environment,
      repo,
      counterparty,
      event.customerReference,
      event
    );
  }

  return patchBvnkWalletFromWebhook(repo, counterparty, event.customerReference, event);
}

export async function handleBvnkRampWebhook(
  c: AppContext,
  environment: SdpEnvironment,
  payload: unknown
) {
  try {
    await processBvnkCustomerWebhook(c, environment, payload);
  } catch (error) {
    console.error(
      `[bvnk webhook] failed to process event: ${error instanceof Error ? error.message : String(error)}`,
      JSON.stringify(payload)
    );
  }
}
