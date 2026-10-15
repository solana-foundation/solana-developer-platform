import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type { Context } from "hono";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPaymentTransferBatchesRepository,
} from "@/db/repositories";
import { resolveSdpEnvironment } from "@/lib/sdp-environment";
import { getRequestTenantScope } from "@/lib/tenant-scope";
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
