import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { Address } from "@solana/kit";
import type { Context } from "hono";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
  createPaymentRecurringPaymentsRepository,
  createPaymentSubscriptionsRepository,
  createPaymentsRepository,
  createPaymentTransferBatchesRepository,
} from "@/db/repositories";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { createRequestSponsorshipFeePayment } from "@/services/sponsorship.service";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/**
 * The ramp runtime for a request, under the cluster scope the project middleware opened.
 *
 * @param c - The request context whose bindings carry the provider credentials.
 * @returns The ramp runtime for the scope's environment.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
export function rampRuntime(c: AppContext): RampRuntimeContext {
  return rampRuntimeForScope(c.env);
}

/**
 * The ramp runtime for the open cluster scope: provider credentials and hosts follow the scope's
 * environment. Shared by requests, ramp webhooks, and ramp jobs, each of which runs under a scope
 * its entry point opened.
 *
 * @param env - Process environment carrying the provider credentials.
 * @returns The ramp runtime for the scope's environment.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
export function rampRuntimeForScope(env: Env): RampRuntimeContext {
  return {
    env: env as unknown as Record<string, string | undefined>,
    mode: currentClusterScope().environment,
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

export function getFeePayment(c: AppContext) {
  return createRequestSponsorshipFeePayment(c);
}

export async function getSponsoredFeePayer(c: AppContext): Promise<Address> {
  return getFeePayment(c).getFeePayer();
}
