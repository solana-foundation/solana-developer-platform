import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
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
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { createRequestSponsorshipFeePayment } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export { resolveSdpEnvironment } from "@/lib/sdp-environment";

export function rampRuntime(c: AppContext): RampRuntimeContext {
  return {
    env: c.env as unknown as Record<string, string | undefined>,
    mode: resolveSdpEnvironment(c),
  };
}

export function getPaymentsRepository(c: AppContext) {
  return createPaymentsRepository(c.env, getRequestTenantScope(c));
}

export function getCounterpartiesRepository(c: AppContext) {
  return createCounterpartiesRepository(c.env, getRequestTenantScope(c));
}

export function getCounterpartyAccountsRepository(c: AppContext) {
  return createCounterpartyAccountsRepository(c.env, getRequestTenantScope(c));
}

export function getPaymentSubscriptionsRepository(c: AppContext) {
  return createPaymentSubscriptionsRepository(c.env, getRequestTenantScope(c));
}

export function getPaymentRecurringPaymentsRepository(c: AppContext) {
  return createPaymentRecurringPaymentsRepository(c.env, getRequestTenantScope(c));
}

export function getPaymentTransferBatchesRepository(c: AppContext) {
  return createPaymentTransferBatchesRepository(c.env, getRequestTenantScope(c));
}

export function getPolicyRepository(c: AppContext) {
  return createPolicyRepository(c.env, getRequestTenantScope(c));
}

export function getFeePayment(c: AppContext) {
  return createRequestSponsorshipFeePayment(c);
}

export async function getSponsoredFeePayer(c: AppContext): Promise<Address> {
  return getFeePayment(c).getFeePayer();
}
