import { currentClusterScope } from "@sdp/rpc/scope";
import { getDb } from "@/db/client";
import { FireblocksProposalsRepository } from "@/db/repositories/fireblocks-proposals.repository";
import { FireblocksReconciliationRepository } from "@/db/repositories/fireblocks-reconciliation.repository";
import type { PaymentsRepository } from "@/db/repositories/payments.repository";
import {
  createSystemPaymentsRepository,
  createSystemTransactionalPaymentsRepository,
} from "@/db/repositories/repository-factory";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { createSystemAuditService } from "@/services/audit.service";
import { pollFireblocksSigningProposal } from "@/services/custody/fireblocks-proposal-reconciliation";
import {
  type ProposalLedger,
  pollFireblocksTransfer,
} from "@/services/payments/fireblocks-transfer";
import type { Env } from "@/types/env";

export const FIREBLOCKS_RECONCILIATION_LIMIT = 100;
export const FIREBLOCKS_RECONCILIATION_CONCURRENCY = 5;
export const FIREBLOCKS_RECONCILIATION_TARGET_MS = 180_000;

/** The ledger for jobs, which run under a system database identity. */
function systemProposalLedger(env: Env, repo: PaymentsRepository): ProposalLedger {
  return {
    repo,
    audited: (work) =>
      createSystemAuditService(env).logSystemWithin((tx) =>
        work(createSystemTransactionalPaymentsRepository(tx))
      ),
  };
}

/** Independent hot lane for both approval queues; no approval-age expiry or resubmission. */
export async function reconcileFireblocksProposals(env: Env): Promise<void> {
  const startedAt = Date.now();
  const { environment } = currentClusterScope();
  const db = getDb(env);
  const queue = new FireblocksReconciliationRepository(db);
  const payments = createSystemPaymentsRepository(env);
  const candidates = await queue.list(environment, FIREBLOCKS_RECONCILIATION_LIMIT);
  const results = await mapSettledWithConcurrency(
    candidates,
    FIREBLOCKS_RECONCILIATION_CONCURRENCY,
    async (candidate) => {
      const scope = { organizationId: candidate.organization_id, projectId: candidate.project_id };
      if (candidate.kind === "transfer") {
        const row = await payments.getTransferById({ ...scope, transferId: candidate.id });
        if (!row) return { polled: false, terminal: false };
        const result = await pollFireblocksTransfer(env, systemProposalLedger(env, payments), row);
        return { polled: result.polled, terminal: result.row.status !== "processing" };
      }
      const repo = new FireblocksProposalsRepository(db, scope);
      const row = await repo.get(candidate.id);
      if (!row) return { polled: false, terminal: false };
      const result = await pollFireblocksSigningProposal(env, repo, row);
      return { polled: result.polled, terminal: result.row.finished_at !== null };
    }
  );
  let polled = 0;
  let skipped = 0;
  let settled = 0;
  const failures: unknown[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      failures.push(result.reason);
      logEvent("warn", {
        event: "sdp_api_fireblocks_reconciliation_failed",
        environment,
        proposal_id: candidates[index]?.id,
        ...describeError(result.reason),
      });
    } else if (!result.value.polled) skipped++;
    else {
      polled++;
      if (result.value.terminal) settled++;
    }
  }
  // A failed aggregate read must fail the cron, never fabricate a zero backlog.
  const stats = await queue.stats(environment, Date.now());
  logEvent(failures.length ? "error" : "info", {
    event: "sdp_api_fireblocks_reconciliation_tick",
    environment,
    pending: stats.pending,
    pending_transfers: stats.transfers,
    pending_signing: stats.signing,
    oldest_unpolled_age_ms: stats.oldestUnpolledAgeMs,
    duration_ms: Date.now() - startedAt,
    selected: candidates.length,
    polled,
    settled,
    skipped,
    failed: failures.length,
    limit: FIREBLOCKS_RECONCILIATION_LIMIT,
    concurrency: FIREBLOCKS_RECONCILIATION_CONCURRENCY,
    target_ms: FIREBLOCKS_RECONCILIATION_TARGET_MS,
  });
  if (failures.length)
    throw new AggregateError(failures, "Fireblocks proposal reconciliation failed");
}
