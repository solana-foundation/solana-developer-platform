import type { SdpEnvironment } from "@sdp/types";
import type { Address } from "@solana/kit";
import type { Context } from "hono";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPaymentTransferBatchesRepository,
  createPolicyRepository,
} from "@/db/repositories";
import { resolveKoraUserId } from "@/lib/kora-user";
import type { RampRuntimeContext } from "@/lib/ramps/types";
import * as feePaymentAdapters from "@/services/adapters/fee-payment";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/**
 * Resolves the product environment for provider credentials.
 * API-key callers are scoped by the key. Dashboard/session callers default to
 * sandbox while that is the only supported dashboard mode.
 */
export function resolveSdpEnvironment(c: AppContext): SdpEnvironment {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return apiKey.environment;
  }
  return "sandbox";
}

export function rampRuntime(c: AppContext): RampRuntimeContext {
  return {
    env: c.env as unknown as Record<string, string | undefined>,
    mode: resolveSdpEnvironment(c),
  };
}

export function getPaymentsRepository(c: AppContext) {
  return createPaymentsRepository(c.env);
}

export function getCounterpartiesRepository(c: AppContext) {
  return createCounterpartiesRepository(c.env);
}

export function getCounterpartyAccountsRepository(c: AppContext) {
  return createCounterpartyAccountsRepository(c.env);
}

export function getPaymentSubscriptionsRepository(c: AppContext) {
  return createPaymentSubscriptionsRepository(c.env);
}

export function getPaymentRecurringPaymentsRepository(c: AppContext) {
  return createPaymentRecurringPaymentsRepository(c.env);
}

export function getPaymentTransferBatchesRepository(c: AppContext) {
  return createPaymentTransferBatchesRepository(c.env);
}

export function getPolicyRepository(c: AppContext) {
  return createPolicyRepository(c.env);
}

export function getFeePayment(c: AppContext) {
  return feePaymentAdapters.createFeePaymentAdapter(c.env, resolveKoraUserId(c));
}

export async function getSponsoredFeePayer(c: AppContext): Promise<Address> {
  return getFeePayment(c).getFeePayer();
}
