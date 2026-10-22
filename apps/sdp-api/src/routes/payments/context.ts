import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPaymentTransferBatchesRepository,
} from "@/db/repositories/repository-factory";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { rampRuntimeFor } from "@/services/ramps/runtime";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/** The runtime a call to `provider` runs under for this request's project mode. */
export function rampRuntime(c: AppContext, provider: RampProviderId): RampRuntimeContext {
  return rampRuntimeFor(c.env, provider, resolveSdpEnvironment(c));
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
