import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";
import {
  APPROVED_WALLET_OPERATIONS_CRON,
  runApprovedWalletOperationRecovery,
} from "./approved-wallet-operations";
import {
  EARN_VAULT_MOVEMENTS_CRON,
  runEarnVaultMovementsReconciliation,
} from "./earn-vault-movements";
import { runPendingDepositsReconciliation } from "./pending-deposits";
import { PENDING_TRANSFERS_CRON, runPendingTransfersReconciliation } from "./pending-transfers";
import { runPendingWithdrawalsReconciliation } from "./pending-withdrawals";
import {
  RECURRING_PAYMENTS_COLLECTION_CRON,
  runRecurringPaymentsCollection,
} from "./recurring-payments";
import { startCron } from "./runner";
import { runWorkflowExecutions, WORKFLOW_EXECUTIONS_CRON } from "./workflow-executions";
import {
  runWorkflowSecretRetirements,
  WORKFLOW_SECRET_RETIREMENTS_CRON,
} from "./workflow-secret-retirements";

const scheduleMock = vi.fn();
const stopMock = vi.fn();
const fakeTask = {
  id: "fake",
  stop: stopMock,
  start: vi.fn(),
  getStatus: vi.fn(),
  destroy: vi.fn(),
  execute: vi.fn(),
  getNextRun: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
};

vi.mock("node-cron", () => ({
  schedule: (...args: unknown[]) => scheduleMock(...args),
}));

vi.mock("./approved-wallet-operations", () => ({
  APPROVED_WALLET_OPERATIONS_CRON: "* * * * *",
  runApprovedWalletOperationRecovery: vi.fn(),
}));

vi.mock("./earn-vault-movements", () => ({
  EARN_VAULT_MOVEMENTS_CRON: "* * * * *",
  runEarnVaultMovementsReconciliation: vi.fn(),
}));

vi.mock("./pending-transfers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pending-transfers")>();
  return {
    ...actual,
    runPendingTransfersReconciliation: vi.fn(),
  };
});

vi.mock("./recurring-payments", () => {
  return {
    RECURRING_PAYMENTS_COLLECTION_CRON: "*/5 * * * *",
    runRecurringPaymentsCollection: vi.fn(),
  };
});

// The private-channels reconcilers pull in heavy Solana modules; mock the wrappers so
// runner.ts loads without them (they're feature-flag gated, off in most tests).
// Unmocked they fail to resolve (@solana/mosaic-sdk ships a directory import Node ESM
// rejects), which also poisons the module graph for any test file sharing the pool.
vi.mock("./pending-deposits", () => ({
  PENDING_DEPOSITS_CRON: "* * * * *",
  runPendingDepositsReconciliation: vi.fn(),
}));

vi.mock("./pending-withdrawals", () => ({
  PENDING_WITHDRAWALS_CRON: "* * * * *",
  runPendingWithdrawalsReconciliation: vi.fn(),
}));

// The workflow engine reaches the same heavy Solana modules as the reconcilers above.
vi.mock("./workflow-executions", () => ({
  WORKFLOW_EXECUTIONS_CRON: "* * * * *",
  runWorkflowExecutions: vi.fn(),
}));

// Pulls in the credential secret store (and through it the custody cipher); mocked for
// the same reason as the wrappers above.
vi.mock("./workflow-secret-retirements", () => ({
  WORKFLOW_SECRET_RETIREMENTS_CRON: "*/5 * * * *",
  runWorkflowSecretRetirements: vi.fn(),
}));

function makeBg(): BackgroundRunner {
  return { run: vi.fn(), awaitAll: vi.fn(async () => {}), draining: false };
}

function makeObservability(): Observability {
  return {
    captureException: vi.fn(),
    withScope: vi.fn(),
    withMonitor: vi.fn(),
  };
}

describe("startCron", () => {
  beforeEach(() => {
    scheduleMock.mockReset();
    stopMock.mockReset();
    scheduleMock.mockReturnValue(fakeTask);
    vi.mocked(runApprovedWalletOperationRecovery).mockReset();
    vi.mocked(runEarnVaultMovementsReconciliation).mockReset();
    vi.mocked(runPendingTransfersReconciliation).mockReset();
    vi.mocked(runRecurringPaymentsCollection).mockReset();
    vi.mocked(runWorkflowExecutions).mockReset();
    vi.mocked(runWorkflowSecretRetirements).mockReset();
  });

  // Asset profiles is on unless a self-hosted operator opts out, so the workflow
  // executions task is part of the DEFAULT schedule — every count below includes it.
  // Its cron expression is indistinguishable from the others here (all mocked to
  // "* * * * *"), so identity is asserted by firing the tick and seeing which
  // reconciler runs.
  //
  // The secret-retirement sweep is registered last and behind no flag at all, so it is
  // in every count below too — including the ones where asset profiles is off.
  const SELF_HOSTED_NO_PROFILES = { SDP_DEPLOYMENT_MODE: "self_hosted" } as Env;

  it("returns null and does not schedule when DISABLE_CRON=true", () => {
    const result = startCron({ env: { DISABLE_CRON: "true" } as Env, bg: makeBg() });
    expect(result).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("returns null and does not schedule when DISABLE_CRON=1", () => {
    const result = startCron({ env: { DISABLE_CRON: "1" } as Env, bg: makeBg() });
    expect(result).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("schedules a task with PENDING_TRANSFERS_CRON when DISABLE_CRON is unset", () => {
    startCron({ env: {} as Env, bg: makeBg() });
    expect(scheduleMock).toHaveBeenCalledTimes(6);
    expect(scheduleMock.mock.calls[0][0]).toBe(APPROVED_WALLET_OPERATIONS_CRON);
    expect(scheduleMock.mock.calls[1][0]).toBe(PENDING_TRANSFERS_CRON);
    expect(scheduleMock.mock.calls[2][0]).toBe(RECURRING_PAYMENTS_COLLECTION_CRON);
    expect(scheduleMock.mock.calls[3][0]).toBe(WORKFLOW_EXECUTIONS_CRON);
    expect(scheduleMock.mock.calls[4][0]).toBe(WORKFLOW_SECRET_RETIREMENTS_CRON);
    expect(scheduleMock.mock.calls[5][0]).toBe(EARN_VAULT_MOVEMENTS_CRON);
  });

  it("schedules workflow executions by default, and its tick runs the engine", () => {
    const bg = makeBg();
    const env = {} as Env;
    const observability = makeObservability();
    startCron({ env, bg, observability });

    (scheduleMock.mock.calls[3][1] as () => void)();
    expect(runWorkflowExecutions).toHaveBeenCalledWith({ env, bg, observability });
  });

  // The engine is the one scheduled task behind a feature flag that defaults ON (asset
  // profiles is only opt-in for self-hosted operators). A self-hosted deployment that
  // has not enabled it must not accumulate a workflow backlog it never drains.
  it("omits workflow executions when asset profiles is off", () => {
    startCron({ env: SELF_HOSTED_NO_PROFILES, bg: makeBg() });

    expect(scheduleMock).toHaveBeenCalledTimes(5);
    for (const call of scheduleMock.mock.calls) {
      (call[1] as () => void)();
    }
    expect(runWorkflowExecutions).not.toHaveBeenCalled();
  });

  // …but the cleanup it used to carry must survive the flag. The retirement queue is
  // durable and only ever holds credentials that are ALREADY orphaned: the rule is gone,
  // nothing references the version, and it stays readable in Secret Manager until
  // something destroys it. Draining it rode on the workflow tick, so turning asset
  // profiles off — a plausible incident response, and exactly when the cleanup matters —
  // stranded every queued retirement permanently, with no consumer left.
  it("still sweeps secret retirements when asset profiles is off", () => {
    const bg = makeBg();
    const observability = makeObservability();
    startCron({ env: SELF_HOSTED_NO_PROFILES, bg, observability });

    for (const call of scheduleMock.mock.calls) {
      (call[1] as () => void)();
    }
    expect(runWorkflowExecutions).not.toHaveBeenCalled();
    expect(runWorkflowSecretRetirements).toHaveBeenCalledWith({
      env: SELF_HOSTED_NO_PROFILES,
      bg,
      observability,
    });
  });

  it("does not schedule by default in a Cloud Run service", () => {
    const result = startCron({ env: { K_SERVICE: "sdp-api" } as Env, bg: makeBg() });
    expect(result).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("allows a Cloud Run service to opt in explicitly", () => {
    startCron({
      env: { K_SERVICE: "sdp-api", DISABLE_CRON: "false" } as Env,
      bg: makeBg(),
    });
    expect(scheduleMock).toHaveBeenCalledTimes(6);
    expect(scheduleMock.mock.calls[0][0]).toBe(APPROVED_WALLET_OPERATIONS_CRON);
    expect(scheduleMock.mock.calls[1][0]).toBe(PENDING_TRANSFERS_CRON);
  });

  // Recurring payments are an always-on product surface: collection schedules
  // behind no flag, like the transfers reconciliation it complements.
  it("schedules recurring collection unconditionally", () => {
    startCron({ env: {} as Env, bg: makeBg() });

    expect(scheduleMock).toHaveBeenCalledTimes(6);
    expect(scheduleMock.mock.calls[2][0]).toBe(RECURRING_PAYMENTS_COLLECTION_CRON);
  });

  it("schedules deposit + withdrawal reconcilers when private channels are enabled", () => {
    const bg = makeBg();
    const env = { PRIVATE_CHANNELS_ENABLED: "true" } as Env;
    startCron({ env, bg });

    // approved-operation recovery + transfers + recurring + workflow executions +
    // deposits + withdrawals + retirements + vault movements.
    expect(scheduleMock).toHaveBeenCalledTimes(8);

    // Fire every scheduled tick; the two private-channels reconcilers must run.
    for (const call of scheduleMock.mock.calls) {
      (call[1] as () => void)();
    }
    expect(runPendingDepositsReconciliation).toHaveBeenCalledWith({
      env,
      bg,
      observability: undefined,
    });
    expect(runPendingWithdrawalsReconciliation).toHaveBeenCalledWith({
      env,
      bg,
      observability: undefined,
    });
  });

  it("schedules when DISABLE_CRON is set to a recognised falsy value ('false' / '0')", () => {
    startCron({ env: { DISABLE_CRON: "false" } as Env, bg: makeBg() });
    startCron({ env: { DISABLE_CRON: "0" } as Env, bg: makeBg() });
    expect(scheduleMock).toHaveBeenCalledTimes(12);
  });

  it("throws on an unrecognised DISABLE_CRON value to surface env typos", () => {
    expect(() => startCron({ env: { DISABLE_CRON: "treu" } as Env, bg: makeBg() })).toThrow(
      /Invalid DISABLE_CRON/
    );
    expect(() => startCron({ env: { DISABLE_CRON: "yes" } as Env, bg: makeBg() })).toThrow(
      /Invalid DISABLE_CRON/
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("normalises DISABLE_CRON case and surrounding whitespace", () => {
    const result = startCron({ env: { DISABLE_CRON: "  TRUE  " } as Env, bg: makeBg() });
    expect(result).toBeNull();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("throws on a blank DISABLE_CRON value rather than defaulting silently", () => {
    expect(() => startCron({ env: { DISABLE_CRON: "   " } as Env, bg: makeBg() })).toThrow(
      /Invalid DISABLE_CRON/
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it("tick invokes runPendingTransfersReconciliation with the supplied deps", () => {
    const bg = makeBg();
    const env = {} as Env;
    const observability = makeObservability();
    startCron({ env, bg, observability });
    const tick = scheduleMock.mock.calls[1][1] as () => void;
    tick();
    expect(runPendingTransfersReconciliation).toHaveBeenCalledWith({ env, bg, observability });
  });

  it("tick invokes approved wallet-operation recovery with the supplied deps", () => {
    const bg = makeBg();
    const env = {} as Env;
    const observability = makeObservability();
    startCron({ env, bg, observability });
    const tick = scheduleMock.mock.calls[0][1] as () => void;
    tick();
    expect(runApprovedWalletOperationRecovery).toHaveBeenCalledWith({ env, bg, observability });
  });

  it("tick invokes vault-movement recovery outside the Earn feature gate", () => {
    const bg = makeBg();
    const env = SELF_HOSTED_NO_PROFILES;
    const observability = makeObservability();
    startCron({ env, bg, observability });
    const tick = scheduleMock.mock.calls.at(-1)?.[1] as () => void;
    tick();
    expect(runEarnVaultMovementsReconciliation).toHaveBeenCalledWith({
      env,
      bg,
      observability,
    });
  });

  it("recurring tick invokes runRecurringPaymentsCollection with the supplied deps", () => {
    const bg = makeBg();
    const env = {} as Env;
    const observability = makeObservability();
    startCron({ env, bg, observability });
    // recovery, transfers, recurring, workflow executions — recurring is third.
    const tick = scheduleMock.mock.calls[2][1] as () => void;
    tick();
    expect(runRecurringPaymentsCollection).toHaveBeenCalledWith({ env, bg, observability });
  });

  it("tick passes observability=undefined through when caller did not supply one", () => {
    const bg = makeBg();
    const env = {} as Env;
    startCron({ env, bg });
    const tick = scheduleMock.mock.calls[1][1] as () => void;
    tick();
    expect(runPendingTransfersReconciliation).toHaveBeenCalledWith({
      env,
      bg,
      observability: undefined,
    });
  });

  it("tick is a no-op after stop() has been called, even if the scheduler fires once more", async () => {
    const handle = startCron({ env: {} as Env, bg: makeBg() });
    await handle?.stop();
    const tick = scheduleMock.mock.calls[0][1] as () => void;
    tick();
    expect(runApprovedWalletOperationRecovery).not.toHaveBeenCalled();
  });

  it("returned handle.stop() delegates to the underlying scheduled task", async () => {
    const handle = startCron({ env: {} as Env, bg: makeBg() });
    expect(handle).not.toBeNull();
    await handle?.stop();
    expect(stopMock).toHaveBeenCalledTimes(6);
  });

  it("returned handle.stop() stops every scheduled task", async () => {
    const handle = startCron({
      env: { PRIVATE_CHANNELS_ENABLED: "true" } as Env,
      bg: makeBg(),
    });
    expect(handle).not.toBeNull();
    await handle?.stop();
    expect(stopMock).toHaveBeenCalledTimes(8);
  });
});
