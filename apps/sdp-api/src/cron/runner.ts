/**
 * The Worker's scheduler (ADR 0011): registers every Cron Definition on node-cron.
 *
 * Cloud Run services skip registration by default, so web replicas never run cron; the
 * always-on worker service sets `DISABLE_CRON=false`. Self-hosted runtimes keep the
 * historical enabled-by-default behavior.
 */

import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { type ScheduledTask, schedule } from "node-cron";
import { dvpTradesCron } from "@/cron/dvp-trades";
import { earnCatalogueSyncCron } from "@/cron/earn-catalogue-sync";
import { earnMetricsRefreshCron } from "@/cron/earn-metrics-refresh";
import { earnSplitSwapsCron } from "@/cron/earn-split-swaps";
import { earnVaultMovementsCron } from "@/cron/earn-vault-movements";
import { idempotencyKeyPruneCron } from "@/cron/idempotency-keys";
import { pendingDepositsCron } from "@/cron/pending-deposits";
import { pendingTransfersCron } from "@/cron/pending-transfers";
import { pendingWithdrawalsCron } from "@/cron/pending-withdrawals";
import { providerCredentialSecretCleanupCron } from "@/cron/provider-credential-secret-cleanup";
import { rampDeliveriesCron } from "@/cron/ramp-deliveries";
import { rampTransferStatusesCron } from "@/cron/ramp-transfer-statuses";
import { rampTransfersCron } from "@/cron/ramp-transfers";
import { recurringPaymentsCron } from "@/cron/recurring-payments";
import { ringsIndexingCron } from "@/cron/rings-indexing";
import { secretRetirementsCron } from "@/cron/secret-retirements";
import { sponsorshipBudgetsCron } from "@/cron/sponsorship-budgets";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import type { BackgroundRunner } from "@/runtime/background";
import { runInEnvironmentClusterScope } from "@/runtime/cluster-scope-runs";
import type { Env } from "@/types/env";
import type { CronDefinition } from "./define-cron";
import { type CronRegistration, logCronRun } from "./run-event";

export interface CronDeps {
  env: Env;
  bg: BackgroundRunner;
}

export interface CronHandle {
  stop(): void | Promise<void>;
}

/** Every Cron Definition the Worker runs. */
export const CRON_DEFINITIONS: readonly CronDefinition[] = [
  pendingTransfersCron,
  sponsorshipBudgetsCron,
  recurringPaymentsCron,
  rampTransfersCron,
  rampDeliveriesCron,
  rampTransferStatusesCron,
  earnVaultMovementsCron,
  earnSplitSwapsCron,
  dvpTradesCron,
  ringsIndexingCron,
  pendingDepositsCron,
  pendingWithdrawalsCron,
  secretRetirementsCron,
  providerCredentialSecretCleanupCron,
  idempotencyKeyPruneCron,
  earnCatalogueSyncCron,
  earnMetricsRefreshCron,
];

/**
 * How long a registration's run may stay in flight before the overlap guard gives up on it.
 * Without a bound, one run that never settles would turn every later slot into
 * `skipped_overlap` (which still reads as alive) until the Worker restarted. Past it the slot is
 * logged as `error` and the next slot may start. The deadline frees the registration and
 * classifies the slot; it cancels nothing (Node cannot stop an async call tree in process), so
 * the abandoned work keeps running beside its successor. Definitions that write per row tolerate
 * that through their claims and compare-and-set; a definition whose writes are set- or
 * snapshot-based holds its own lock until its work settles (the catalogue sync is the exemplar).
 * Real cancellation is HOO-2163. Ten minutes is far above any healthy run and short enough that
 * a wedged money exit resumes the same hour. It equals the catalogue sync's own 600 s deadline,
 * so a sync that runs into its deadline logs two `error` events for one slot (this one first,
 * then the sync's own rejection).
 */
const CRON_SLOT_DEADLINE_MS = 10 * 60_000;

/** A run that outlived `CRON_SLOT_DEADLINE_MS`; its registration was freed for the next slot. */
class CronSlotDeadlineExceededError extends Error {
  readonly code = "CRON_SLOT_DEADLINE_EXCEEDED";

  constructor(cron: string) {
    super(`${cron} run exceeded the ${CRON_SLOT_DEADLINE_MS / 60_000}-minute cron slot deadline`);
    this.name = "CronSlotDeadlineExceededError";
  }
}

const TRUTHY_DISABLE_CRON: ReadonlySet<string> = new Set(["true", "1"]);
const FALSY_DISABLE_CRON: ReadonlySet<string> = new Set(["false", "0"]);

// Strict whitelist so a typo (`DISABLE_CRON=treu`) fails loudly instead of
// silently enabling cron and double-firing across replicas.
function isCronDisabled(env: Pick<Env, "DISABLE_CRON" | "K_SERVICE">): boolean {
  const raw = env.DISABLE_CRON;
  if (raw === undefined) {
    return Boolean(env.K_SERVICE);
  }
  const normalised = raw.trim().toLowerCase();
  if (TRUTHY_DISABLE_CRON.has(normalised)) {
    return true;
  }
  if (FALSY_DISABLE_CRON.has(normalised)) {
    return false;
  }
  throw new Error(
    `Invalid DISABLE_CRON: ${JSON.stringify(raw)} (expected 'true', 'false', '1', or '0')`
  );
}

/** Throws on an invalid DISABLE_CRON, so the entrypoint fails before it opens sockets. */
export function assertCronConfig(env: Pick<Env, "DISABLE_CRON" | "K_SERVICE">): void {
  isCronDisabled(env);
}

/**
 * The Environments a definition is registered for: one per Environment for `cluster`, a single
 * environment-less registration for `global`.
 *
 * @param definition - The definition to register.
 * @returns One entry per registration.
 */
function registrationEnvironments(definition: CronDefinition): readonly (SdpEnvironment | null)[] {
  switch (definition.scope) {
    case "cluster":
      return SDP_ENVIRONMENTS;
    case "global":
      return [null];
    default: {
      const unreachable: never = definition.scope;
      throw new Error(`Unhandled cron scope: ${String(unreachable)}`);
    }
  }
}

/**
 * Run one slot of a definition's work under the system database identity (reconciliation is
 * cross-tenant, and row-level security denies an undeclared workload) and, for a `cluster`
 * registration, inside that Environment's cluster scope. Logs the slot's outcome and rethrows
 * a failure so the background runner records it.
 *
 * @param definition - The definition whose slot fired.
 * @param registration - The registration the slot belongs to.
 * @param env - Process environment handed to the work.
 * @returns Resolves once the work has, after logging the outcome.
 */
async function runSlot(
  definition: CronDefinition,
  registration: CronRegistration,
  env: Env
): Promise<void> {
  const startedAt = Date.now();
  const environment = registration.environment;
  try {
    await runWithSystemDatabaseIdentity(`cron:${definition.name}`, () =>
      environment === null
        ? definition.run(env)
        : runInEnvironmentClusterScope(environment, () => definition.run(env))
    );
  } catch (error) {
    logCronRun(registration, { status: "error", durationMs: Date.now() - startedAt, cause: error });
    throw error;
  }
  logCronRun(registration, { status: "ok", durationMs: Date.now() - startedAt });
}

/**
 * Register every Cron Definition on node-cron, once per registration. A disabled definition's
 * slots only log `disabled`; an enabled one's slot is skipped as `skipped_overlap` while the
 * same registration's previous run is in flight (for at most `CRON_SLOT_DEADLINE_MS`), otherwise
 * its work runs and the promise is handed to the background runner so shutdown drains it.
 *
 * @param deps - Process environment and background runner.
 * @returns A handle that stops every registration, or `null` when cron is disabled here.
 */
export function startCron(deps: CronDeps): CronHandle | null {
  if (isCronDisabled(deps.env)) {
    return null;
  }

  // node-cron's `task.stop()` halts future scheduling but doesn't promise
  // to interrupt a tick already mid-flight. A `stopping` flag short-circuits
  // any callback that fires concurrent with shutdown so no extra background
  // work gets registered after the awaitAll() snapshot is taken.
  let stopping = false;
  const tasks: ScheduledTask[] = [];

  for (const definition of CRON_DEFINITIONS) {
    const enabled = definition.enabled(deps.env);
    for (const environment of registrationEnvironments(definition)) {
      const registration: CronRegistration = { cron: definition.name, environment };
      // The in-flight run's own token, so a run abandoned at the deadline that settles later
      // cannot free the registration from under its successor.
      let inFlight: symbol | null = null;
      const fire = () => {
        if (stopping) {
          return;
        }
        if (!enabled) {
          logCronRun(registration, { status: "disabled" });
          return;
        }
        if (inFlight !== null) {
          logCronRun(registration, { status: "skipped_overlap" });
          return;
        }
        const slot = Symbol(definition.name);
        inFlight = slot;
        const deadline = setTimeout(() => {
          if (inFlight !== slot) {
            return;
          }
          inFlight = null;
          logCronRun(registration, {
            status: "error",
            durationMs: CRON_SLOT_DEADLINE_MS,
            cause: new CronSlotDeadlineExceededError(definition.name),
          });
        }, CRON_SLOT_DEADLINE_MS);
        deadline.unref();
        deps.bg.run(
          runSlot(definition, registration, deps.env).finally(() => {
            clearTimeout(deadline);
            if (inFlight === slot) {
              inFlight = null;
            }
          })
        );
      };
      tasks.push(schedule(definition.schedule, fire));
      if (definition.runOnStart === true) {
        fire();
      }
    }
  }

  return {
    stop() {
      stopping = true;
      for (const task of tasks) {
        task.stop();
      }
    },
  };
}
