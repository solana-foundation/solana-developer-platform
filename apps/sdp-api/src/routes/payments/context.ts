import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
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
import { AuditService } from "@/services/audit.service";
import type { ProposalLedger } from "@/services/payments/fireblocks-transfer";
import { rampRuntimeFor } from "@/services/ramps/runtime";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/** The runtime a call to `provider` runs under for this request's project mode. */
export function rampRuntime(c: AppContext, provider: RampProviderId): RampRuntimeContext {
  return rampRuntimeFor(c.env, provider, resolveSdpEnvironment(c));
}

/**
 * The request's ledger for proposed-transfer row state: a settle commits with its audit outcome
 * in the request's own ledger transaction.
 */
export function requestProposalLedger(
  c: AppContext,
  auditService: AuditService = new AuditService(getDb(c.env))
): ProposalLedger {
  return {
    repo: getPaymentsRepository(c),
    audited: (work) =>
      auditService.logWithin(c, (tx) =>
        work(createPostgresPaymentsRepository(tx, getRequestTenantScope(c)))
      ),
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
