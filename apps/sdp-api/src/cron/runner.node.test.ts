import { RpcTimeoutError, SdpRpcError } from "@sdp/rpc/errors";
import { currentClusterScope } from "@sdp/rpc/scope";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import type { CronRunStatus } from "@sdp/types/cron-runs";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from "vitest";
import { z } from "zod";
import { currentDatabaseIdentity, type DatabaseIdentity } from "@/db/identity";
import type { BackgroundRunner } from "@/runtime/background";
import * as moneyPathEvents from "@/runtime/money-path-events";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";
import { earnCatalogueSyncCron } from "./earn-catalogue-sync";
import { pendingTransfersCron } from "./pending-transfers";
import { ringsIndexingCron } from "./rings-indexing";
import { CRON_RUN_EVENT, type CronRegistration } from "./run-event";
import { assertCronConfig, CRON_DEFINITIONS, type CronHandle, startCron } from "./runner";

interface ScheduledFake {
  expression: string;
  fire: () => void;
  stop: Mock<() => void>;
}

interface RunObservation {
  cron: string;
  environment: SdpEnvironment | null;
  identity: DatabaseIdentity | undefined;
}

interface DiscoveredRegistration extends CronRegistration {
  schedule: string;
  ran: RunObservation[];
}

interface RecordingBackgroundRunner {
  bg: BackgroundRunner;
  runs: Promise<unknown>[];
}

interface Worker extends RecordingBackgroundRunner {
  handle: CronHandle;
  registrations: Map<string, ScheduledFake>;
  discovered: DiscoveredRegistration[];
}

const scheduler = vi.hoisted(() => {
  const tasks: ScheduledFake[] = [];
  return { tasks };
});

vi.mock("node-cron", () => ({
  schedule: (expression: string, fire: () => void) => {
    const task = { expression, fire, stop: vi.fn<() => void>() };
    scheduler.tasks.push(task);
    return task;
  },
}));

const SLOT_DEADLINE_MS = 10 * 60_000;

const observations: RunObservation[] = [];
let logEventSpy: MockInstance<typeof moneyPathEvents.logEvent>;

function openClusterEnvironment(): SdpEnvironment | null {
  try {
    return currentClusterScope().environment;
  } catch (error) {
    if (error instanceof SdpRpcError && error.code === "CLUSTER_SCOPE_MISSING") {
      return null;
    }
    throw error;
  }
}

function recordingBackgroundRunner(): RecordingBackgroundRunner {
  const runs: Promise<unknown>[] = [];
  const bg: BackgroundRunner = {
    run: (promise) => {
      runs.push(promise);
    },
    awaitAll: async () => {
      await Promise.allSettled(runs);
    },
    draining: false,
  };
  return { bg, runs };
}

const loggedRegistrationSchema = z.object({
  cron: z.string(),
  environment: z.enum(SDP_ENVIRONMENTS).nullable(),
});

function lastLoggedRegistration(): CronRegistration {
  const [, payload] = required(logEventSpy.mock.lastCall);
  return loggedRegistrationSchema.parse(payload);
}

function registrationKey(cron: string, environment: SdpEnvironment | null): string {
  return JSON.stringify([cron, environment]);
}

async function startWorker(): Promise<Worker> {
  const { bg, runs } = recordingBackgroundRunner();
  const handle = required(startCron({ env, bg }));
  await bg.awaitAll();
  const registrations = new Map<string, ScheduledFake>();
  const discovered: DiscoveredRegistration[] = [];
  for (const task of scheduler.tasks) {
    const observed = observations.length;
    task.fire();
    await bg.awaitAll();
    const { cron, environment } = lastLoggedRegistration();
    registrations.set(registrationKey(cron, environment), task);
    discovered.push({
      cron,
      environment,
      schedule: task.expression,
      ran: observations.slice(observed),
    });
  }
  logEventSpy.mockClear();
  observations.length = 0;
  return { bg, runs, handle, registrations, discovered };
}

function fire(
  worker: Worker,
  cron: string,
  environment: SdpEnvironment | null
): Promise<unknown>[] {
  const handed = worker.runs.length;
  required(worker.registrations.get(registrationKey(cron, environment))).fire();
  return worker.runs.slice(handed);
}

function runEvents(cron: string, environment: SdpEnvironment | null) {
  return logEventSpy.mock.calls.filter(
    ([, payload]) =>
      payload.event === CRON_RUN_EVENT &&
      payload.cron === cron &&
      payload.environment === environment
  );
}

function slotEvent(cron: string, environment: SdpEnvironment | null, status: CronRunStatus) {
  return { event: CRON_RUN_EVENT, cron, environment, status, monitor: `sdp-api-${cron}` };
}

function okEvent(cron: string, environment: SdpEnvironment | null) {
  return ["info", { ...slotEvent(cron, environment, "ok"), duration_ms: expect.any(Number) }];
}

function deadlineEvent(cron: string, environment: SdpEnvironment | null) {
  return [
    "error",
    {
      ...slotEvent(cron, environment, "error"),
      duration_ms: SLOT_DEADLINE_MS,
      error_name: "CronSlotDeadlineExceededError",
      error_code: "CRON_SLOT_DEADLINE_EXCEEDED",
    },
  ];
}

beforeEach(() => {
  scheduler.tasks.length = 0;
  observations.length = 0;
  logEventSpy = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});
  for (const definition of CRON_DEFINITIONS) {
    vi.spyOn(definition, "enabled").mockReturnValue(true);
    vi.spyOn(definition, "run").mockImplementation(async () => {
      observations.push({
        cron: definition.name,
        environment: openClusterEnvironment(),
        identity: currentDatabaseIdentity(),
      });
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startCron", () => {
  it("registers a cluster definition once per environment inside its scope and a global one once outside any scope", async () => {
    const worker = await startWorker();

    const expected = CRON_DEFINITIONS.flatMap((definition) => {
      const environments: readonly (SdpEnvironment | null)[] =
        definition.scope === "cluster" ? SDP_ENVIRONMENTS : [null];
      return environments.map((environment) => ({
        cron: definition.name,
        environment,
        schedule: definition.schedule,
        scopes: [environment],
      }));
    });
    const registered = worker.discovered.map(({ cron, environment, schedule, ran }) => ({
      cron,
      environment,
      schedule,
      scopes: ran.map((run) => run.environment),
    }));
    expect(registered).toHaveLength(expected.length);
    expect(registered).toEqual(expect.arrayContaining(expected));
  });

  it("runs every slot under the system database identity named for its definition", async () => {
    const worker = await startWorker();

    const ran = worker.discovered.flatMap((registration) => registration.ran);
    expect(ran).toHaveLength(scheduler.tasks.length);
    expect(ran.map((run) => run.identity)).toEqual(
      ran.map((run) => ({ kind: "system", component: `cron:${run.cron}` }))
    );
  });

  it("logs only disabled for a definition whose enabled decision was false, deciding it once", async () => {
    vi.mocked(ringsIndexingCron.enabled).mockReturnValue(false);
    const worker = await startWorker();

    expect(fire(worker, ringsIndexingCron.name, null)).toEqual([]);
    expect(fire(worker, ringsIndexingCron.name, null)).toEqual([]);

    const disabled = ["info", slotEvent(ringsIndexingCron.name, null, "disabled")];
    expect(runEvents(ringsIndexingCron.name, null)).toEqual([disabled, disabled]);
    expect(ringsIndexingCron.run).not.toHaveBeenCalled();
    expect(ringsIndexingCron.enabled).toHaveBeenCalledExactlyOnceWith(env);
  });

  it("skips a slot while the same registration's run is in flight, and runs the next slot once it settles", async () => {
    const worker = await startWorker();
    const held = deferred<void>();
    vi.mocked(pendingTransfersCron.run).mockImplementationOnce(() => held.promise);
    const name = pendingTransfersCron.name;

    const [first] = fire(worker, name, "production");
    expect(fire(worker, name, "production")).toEqual([]);
    const [sandbox] = fire(worker, name, "sandbox");
    await sandbox;
    held.resolve();
    await first;
    const [next] = fire(worker, name, "production");
    await next;

    expect(runEvents(name, "production")).toEqual([
      ["warn", slotEvent(name, "production", "skipped_overlap")],
      okEvent(name, "production"),
      okEvent(name, "production"),
    ]);
    expect(runEvents(name, "sandbox")).toEqual([okEvent(name, "sandbox")]);
  });

  it("frees a registration whose run outlives the slot deadline, logging it as error, so the next slot starts a new run", async () => {
    vi.useFakeTimers();
    const worker = await startWorker();
    const abandoned = deferred<void>();
    vi.mocked(pendingTransfersCron.run).mockImplementationOnce(() => abandoned.promise);
    const name = pendingTransfersCron.name;

    expect(fire(worker, name, "production")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SLOT_DEADLINE_MS);
    const [next] = fire(worker, name, "production");
    await next;

    expect(runEvents(name, "production")).toEqual([
      deadlineEvent(name, "production"),
      okEvent(name, "production"),
    ]);
  });

  it("keeps a registration owned by its newer run when the run abandoned at the deadline settles", async () => {
    vi.useFakeTimers();
    const worker = await startWorker();
    const abandoned = deferred<void>();
    const successor = deferred<void>();
    vi.mocked(pendingTransfersCron.run)
      .mockImplementationOnce(() => abandoned.promise)
      .mockImplementationOnce(() => successor.promise);
    const name = pendingTransfersCron.name;

    const [abandonedRun] = fire(worker, name, "production");
    await vi.advanceTimersByTimeAsync(SLOT_DEADLINE_MS);
    const [successorRun] = fire(worker, name, "production");
    abandoned.resolve();
    await abandonedRun;
    expect(fire(worker, name, "production")).toEqual([]);
    successor.resolve();
    await successorRun;

    expect(runEvents(name, "production")).toEqual([
      deadlineEvent(name, "production"),
      okEvent(name, "production"),
      ["warn", slotEvent(name, "production", "skipped_overlap")],
      okEvent(name, "production"),
    ]);
  });

  it("logs no deadline error for a run that settled before the slot deadline", async () => {
    vi.useFakeTimers();
    const worker = await startWorker();
    const name = pendingTransfersCron.name;

    const [run] = fire(worker, name, "production");
    await run;
    await vi.advanceTimersByTimeAsync(2 * SLOT_DEADLINE_MS);

    expect(logEventSpy.mock.calls).toEqual([okEvent(name, "production")]);
  });

  it("logs a failed run as error with its name and code, hands the failure to the background runner, and runs the next slot", async () => {
    const worker = await startWorker();
    const timeout = new RpcTimeoutError(30_000);
    vi.mocked(pendingTransfersCron.run).mockRejectedValueOnce(timeout);
    const name = pendingTransfersCron.name;

    const [failed] = fire(worker, name, "sandbox");
    await expect(failed).rejects.toBe(timeout);
    const [next] = fire(worker, name, "sandbox");
    await next;

    expect(runEvents(name, "sandbox")).toEqual([
      [
        "error",
        {
          ...slotEvent(name, "sandbox", "error"),
          duration_ms: expect.any(Number),
          error_name: "RpcTimeoutError",
          error_code: "SOLANA_RPC_ERROR",
        },
      ],
      okEvent(name, "sandbox"),
    ]);
    expect(observations).toEqual([
      {
        cron: name,
        environment: "sandbox",
        identity: { kind: "system", component: `cron:${name}` },
      },
    ]);
  });

  it("runs a runOnStart definition once as soon as it is registered", async () => {
    const { bg, runs } = recordingBackgroundRunner();

    startCron({ env, bg });

    expect(runs).toHaveLength(1);
    await bg.awaitAll();
    expect(observations).toEqual([
      {
        cron: earnCatalogueSyncCron.name,
        environment: null,
        identity: { kind: "system", component: `cron:${earnCatalogueSyncCron.name}` },
      },
    ]);
    expect(runEvents(earnCatalogueSyncCron.name, null)).toEqual([
      okEvent(earnCatalogueSyncCron.name, null),
    ]);
  });

  it("logs disabled at registration for a disabled runOnStart definition and runs nothing", () => {
    vi.mocked(earnCatalogueSyncCron.enabled).mockReturnValue(false);
    const { bg, runs } = recordingBackgroundRunner();

    startCron({ env, bg });

    expect(runs).toEqual([]);
    expect(earnCatalogueSyncCron.run).not.toHaveBeenCalled();
    expect(runEvents(earnCatalogueSyncCron.name, null)).toEqual([
      ["info", slotEvent(earnCatalogueSyncCron.name, null, "disabled")],
    ]);
  });

  it("stops every task, and a slot that fires after stop() does nothing", async () => {
    const worker = await startWorker();

    await worker.handle.stop();

    expect(scheduler.tasks.map((task) => task.stop.mock.calls.length)).toEqual(
      scheduler.tasks.map(() => 1)
    );
    expect(fire(worker, pendingTransfersCron.name, "production")).toEqual([]);
    expect(logEventSpy).not.toHaveBeenCalled();
    expect(observations).toEqual([]);
  });

  it("lets a run in flight at stop() finish through the background runner and log its outcome", async () => {
    const worker = await startWorker();
    const held = deferred<void>();
    vi.mocked(pendingTransfersCron.run).mockImplementationOnce(() => held.promise);
    const name = pendingTransfersCron.name;

    expect(fire(worker, name, "production")).toHaveLength(1);
    await worker.handle.stop();
    held.resolve();
    await worker.bg.awaitAll();

    expect(runEvents(name, "production")).toEqual([okEvent(name, "production")]);
  });
});

describe("DISABLE_CRON", () => {
  it.each(["true", "1", "  TRUE  "])("does not start when DISABLE_CRON is %j", (value) => {
    expect(() => assertCronConfig({ DISABLE_CRON: value })).not.toThrow();
    expect(
      startCron({ env: { ...env, DISABLE_CRON: value }, bg: recordingBackgroundRunner().bg })
    ).toBeNull();
    expect(scheduler.tasks).toEqual([]);
  });

  it("does not start in a Cloud Run service that leaves DISABLE_CRON unset", () => {
    expect(
      startCron({ env: { ...env, K_SERVICE: "sdp-api" }, bg: recordingBackgroundRunner().bg })
    ).toBeNull();
    expect(scheduler.tasks).toEqual([]);
  });

  it.each(["false", "0"])("starts a Cloud Run service that sets DISABLE_CRON to %j", (value) => {
    const cloudRunEnv = { ...env, K_SERVICE: "sdp-api-worker", DISABLE_CRON: value };

    expect(() => assertCronConfig(cloudRunEnv)).not.toThrow();
    expect(startCron({ env: cloudRunEnv, bg: recordingBackgroundRunner().bg })).not.toBeNull();
    expect(scheduler.tasks).not.toEqual([]);
  });

  it.each(["treu", "yes", "   "])("refuses DISABLE_CRON %j before scheduling anything", (value) => {
    const message = `Invalid DISABLE_CRON: ${JSON.stringify(value)}`;

    expect(() => assertCronConfig({ DISABLE_CRON: value })).toThrow(message);
    expect(() =>
      startCron({ env: { ...env, DISABLE_CRON: value }, bg: recordingBackgroundRunner().bg })
    ).toThrow(message);
    expect(scheduler.tasks).toEqual([]);
  });
});
