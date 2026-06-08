import type { SdpEnvironment } from "@sdp/types";
import type { Context } from "hono";
import { createCounterpartiesRepository } from "@/db/repositories";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import {
  findBvnkWalletEntryKey,
  isBvnkCustomerVerified,
  readBvnkCustomer,
} from "@/lib/ramps/providers/bvnk";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

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

  const providerData = counterparty.provider_data;

  if (event.kind === "customer") {
    const current = readBvnkCustomer(providerData);
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
        { reference: event.customerReference }
      );
      customer.status = latest.status.toUpperCase();
      customer.verificationStatus = latest.verificationStatus;
      if (latest.verificationUrl) customer.verificationUrl = latest.verificationUrl;
    }
    if (Object.keys(customer).length === 0) {
      return;
    }
    await repo.patchBvnkCustomerByReference({
      customerReference: event.customerReference,
      customer,
    });
    return;
  }

  if (event.kind !== "wallet") {
    return;
  }

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

  const key = findBvnkWalletEntryKey(providerData, event.walletId);
  if (!key) {
    return;
  }
  const wallet: Record<string, unknown> = {};
  if (event.walletStatus) wallet.walletStatus = event.walletStatus;
  if (hasBankAccountNumber) wallet.bankAccount = bankAccount;
  await repo.patchBvnkWalletByReference({
    customerReference: event.customerReference,
    walletKey: key,
    wallet,
  });
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
