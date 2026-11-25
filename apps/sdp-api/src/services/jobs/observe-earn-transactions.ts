import { createClusterRpc } from "@sdp/rpc/factory";
import { currentClusterScope } from "@sdp/rpc/scope";
import { getSignatureStatuses } from "@sdp/rpc/solana";
import { signature } from "@solana/kit";
import { getDb } from "@/db/client";
import {
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
} from "@/db/repositories/earn-movements.repository";
import {
  earnObservationDelay,
  releaseEarnObservations,
} from "@/db/repositories/earn-observation-claims";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnVaultWithdrawalRequestActionRow,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { observeEarnVaultMovementStatus } from "@/services/earn/vault-movement-reconciliation.service";
import { observeEarnWithdrawalActionStatus } from "@/services/earn/vault-queued-withdrawal-reconciliation.service";
import type { Env } from "@/types/env";

const BATCH_PER_KIND = 64;
const PASS_BUDGET_MS = 4_000;

type Target =
  | { kind: "movement"; row: EarnMovementRow; token: string }
  | { kind: "withdrawal_action"; row: EarnVaultWithdrawalRequestActionRow; token: string };

/** One bounded, horizontally partitioned pass over direct and queued transaction signatures. */
export async function observeEarnTransactions(
  env: Env
): Promise<{ claimed: number; saturated: boolean }> {
  const startedAt = Date.now();
  const { environment } = currentClusterScope();
  const db = getDb(env);
  const targets: Target[] = [];
  const failed = new Set<string>();
  const attempted = new Set<string>();
  let statusReadFailed = false;
  let advanced = 0;
  const released = new Set<Target>();
  async function releaseTargets(selected: readonly Target[]): Promise<void> {
    const groups = new Map<string, { targets: Target[]; delayMs: number }>();
    for (const target of selected) {
      let release: "unattempted" | "attempted" | "status_read_failed" = "unattempted";
      if (attempted.has(target.row.id)) release = "attempted";
      if (statusReadFailed) release = "status_read_failed";
      let delayMs: number;
      switch (release) {
        case "unattempted":
          delayMs = 0;
          break;
        case "attempted":
          delayMs = earnObservationDelay(target.row.created_at, failed.has(target.row.id));
          break;
        case "status_read_failed":
          delayMs = earnObservationDelay(target.row.created_at, true);
          break;
        default: {
          const unreachable: never = release;
          throw new Error(`Unhandled observation release: ${unreachable}`);
        }
      }
      const key = `${target.kind}:${target.token}:${delayMs}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { targets: [target], delayMs });
      else group.targets.push(target);
    }
    const releases = await mapSettledWithConcurrency([...groups.values()], 4, async (group) => {
      const first = group.targets[0];
      if (first === undefined) throw new Error("Empty observation release group");
      await releaseEarnObservations(
        db,
        first.kind,
        group.targets.map((target) => target.row),
        first.token,
        group.delayMs
      );
      for (const target of group.targets) released.add(target);
    });
    const errors = releases.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Earn observation or claim release failed");
    }
  }
  const run = async () => {
    const movements = await createPostgresEarnMovementsRepository(db).claimDueObservations(
      environment,
      BATCH_PER_KIND
    );
    targets.push(
      ...movements.rows.map((row): Target => ({ kind: "movement", row, token: movements.token }))
    );
    const actions = await createPostgresEarnVaultWithdrawalRequestsRepository(
      db
    ).claimDueObservations(environment, BATCH_PER_KIND);
    targets.length = 0;
    // Give direct and queued actions equal access to the bounded processing budget.
    for (let index = 0; index < Math.max(movements.rows.length, actions.rows.length); index += 1) {
      const movement = movements.rows[index];
      const action = actions.rows[index];
      if (movement !== undefined)
        targets.push({ kind: "movement", row: movement, token: movements.token });
      if (action !== undefined)
        targets.push({ kind: "withdrawal_action", row: action, token: actions.token });
    }
    const saturated = movements.scanned === BATCH_PER_KIND || actions.scanned === BATCH_PER_KIND;
    if (targets.length === 0) return { claimed: 0, saturated };

    const signatures = [
      ...new Set(
        targets.map(({ row }) => {
          if (row.signature === null) throw new Error("Signed Earn observation has no signature");
          return signature(row.signature);
        })
      ),
    ];
    const rpc = createClusterRpc({ timeoutMs: 2_000 });
    statusReadFailed = true;
    const statuses = await getSignatureStatuses(rpc, signatures, {
      searchTransactionHistory: true,
      retryDelaysMs: [],
    });
    statusReadFailed = false;
    const bySignature = new Map(signatures.map((sent, index) => [sent, statuses[index] ?? null]));
    const unobserved = targets.filter((target) => {
      const observed =
        target.row.signature === null ? null : bySignature.get(signature(target.row.signature));
      return observed === null || observed === undefined;
    });
    // A signature miss needs no reducer. Release it before slow receipt/provider
    // work so minute recovery can rebroadcast or prove expiry during this pass.
    for (const target of unobserved) attempted.add(target.row.id);
    await releaseTargets(unobserved);
    const expiresAt = Date.now() + PASS_BUDGET_MS;
    const results = await mapSettledWithConcurrency(
      targets.filter((target) => !released.has(target)),
      4,
      async (target) => {
        if (Date.now() >= expiresAt) return;
        attempted.add(target.row.id);
        const observed =
          target.row.signature === null ? null : bySignature.get(signature(target.row.signature));
        // Absence carries no finality, resend or expiry authority in this lane.
        if (observed === null || observed === undefined) return;
        try {
          const outcome =
            target.kind === "movement"
              ? await observeEarnVaultMovementStatus(env, target.row, observed, rpc)
              : await observeEarnWithdrawalActionStatus(env, target.row, observed, rpc);
          if (outcome !== "unchanged") advanced += 1;
        } catch (error) {
          failed.add(target.row.id);
          throw error;
        }
      }
    );
    for (const result of results) {
      if (result.status === "rejected") {
        getLogger().error(
          { error: result.reason, environment },
          "Earn transaction observation failed"
        );
      }
    }
    logEvent(failed.size > 0 ? "error" : "info", {
      event: "sdp_api_earn_transaction_observation_tick",
      environment,
      claimed: targets.length,
      signatures: signatures.length,
      advanced,
      errors: failed.size,
      duration_ms: Date.now() - startedAt,
    });
    if (failed.size > 0) throw new Error(`${failed.size} Earn transactions could not be observed`);
    return {
      claimed: targets.length,
      saturated,
    };
  };
  const [result] = await Promise.allSettled([run()]);
  try {
    await releaseTargets(targets.filter((target) => !released.has(target)));
  } catch (cause) {
    const errors = [cause];
    if (result.status === "rejected") errors.unshift(result.reason);
    throw new AggregateError(errors, "Earn observation or claim release failed");
  }
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
