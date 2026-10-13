import { type ClusterScope, currentClusterScope, runInClusterScope } from "@sdp/rpc/scope";
import { CLUSTER_BY_SDP_ENVIRONMENT, SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPerCluster } from "./cluster-runs";

const logEvent = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

describe("runPerCluster", () => {
  beforeEach(() => {
    logEvent.mockClear();
  });

  it("runs the work once per environment inside that environment's cluster scope with no project", async () => {
    const scopes: ClusterScope[] = [];

    await runPerCluster("test-job", async () => {
      scopes.push(currentClusterScope());
    });

    expect(scopes).toEqual(
      SDP_ENVIRONMENTS.map((environment) => ({
        projectId: null,
        environment,
        cluster: CLUSTER_BY_SDP_ENVIRONMENT[environment],
      }))
    );
  });

  it("completes the other environment's concurrent run and rethrows the one failure", async () => {
    const productionFailure = new Error("mainnet-beta unavailable");
    const started: SdpEnvironment[] = [];
    const completed: SdpEnvironment[] = [];

    const running = runPerCluster("test-job", async () => {
      const { environment } = currentClusterScope();
      started.push(environment);
      if (environment === "production") {
        throw productionFailure;
      }
      await vi.waitFor(() => {
        expect(started).toContain("production");
      });
      completed.push(environment);
    });

    await expect(running).rejects.toBe(productionFailure);
    expect(completed).toEqual(["sandbox"]);
    expect(logEvent).toHaveBeenCalledExactlyOnceWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_cluster_job_run_failed",
        job: "test-job",
        environment: "production",
      })
    );
  });

  it("completes the equal-facts run and logs and rethrows the conflicting run's synchronous scope throw", async () => {
    const completed: ClusterScope[] = [];

    const running = runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      runPerCluster("test-job", async () => {
        await Promise.resolve();
        completed.push(currentClusterScope());
      })
    );

    await expect(running).rejects.toMatchObject({
      code: "CLUSTER_SCOPE_CONFLICT",
      details: { openEnvironment: "sandbox", requestedEnvironment: "production" },
    });
    expect(completed).toEqual([
      { projectId: null, environment: "sandbox", cluster: CLUSTER_BY_SDP_ENVIRONMENT.sandbox },
    ]);
    expect(logEvent).toHaveBeenCalledExactlyOnceWith(
      "error",
      expect.objectContaining({
        event: "sdp_api_cluster_job_run_failed",
        job: "test-job",
        environment: "production",
      })
    );
  });

  it("aggregates every environment's failure when all runs fail", async () => {
    const failures = {
      sandbox: new Error("devnet unavailable"),
      production: new Error("mainnet-beta unavailable"),
    } as const satisfies Record<SdpEnvironment, Error>;

    const running = runPerCluster("test-job", async () => {
      throw failures[currentClusterScope().environment];
    });

    await expect(running).rejects.toEqual(
      new AggregateError(
        SDP_ENVIRONMENTS.map((environment) => failures[environment]),
        "test-job failed on more than one cluster"
      )
    );
    expect(logEvent).toHaveBeenCalledTimes(SDP_ENVIRONMENTS.length);
  });
});
