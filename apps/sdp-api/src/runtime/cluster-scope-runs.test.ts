import { type ClusterScope, currentClusterScope, runInClusterScope } from "@sdp/rpc/scope";
import { CLUSTER_BY_SDP_ENVIRONMENT, SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { runInEachClusterScope } from "./cluster-scope-runs";

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runInEachClusterScope", () => {
  it("runs the work once inside each environment's own cluster scope", async () => {
    const scopes: ClusterScope[] = [];

    await runInEachClusterScope(async () => {
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

  it("rethrows one run's rejection only after the other run completes", async () => {
    const failure = new Error("sandbox run failed");
    const completed: SdpEnvironment[] = [];

    await expect(
      runInEachClusterScope(async () => {
        const { environment } = currentClusterScope();
        if (environment === "sandbox") {
          throw failure;
        }
        await nextMacrotask();
        completed.push(environment);
      })
    ).rejects.toBe(failure);
    expect(completed).toEqual(["production"]);
  });

  it("collapses a rejection from every run into one AggregateError", async () => {
    const rejection = runInEachClusterScope(async () => {
      throw new Error(`${currentClusterScope().environment} run failed`);
    });

    await expect(rejection).rejects.toBeInstanceOf(AggregateError);
    await expect(rejection).rejects.toMatchObject({
      errors: SDP_ENVIRONMENTS.map((environment) =>
        expect.objectContaining({ message: `${environment} run failed` })
      ),
    });
  });

  it("settles every run before rejecting with the scope conflict an open scope causes", async () => {
    const started: SdpEnvironment[] = [];

    await expect(
      runInClusterScope({ projectId: "prj_conflicting_scope", environment: "sandbox" }, () =>
        runInEachClusterScope(async () => {
          started.push(currentClusterScope().environment);
        })
      )
    ).rejects.toMatchObject({
      errors: SDP_ENVIRONMENTS.map(() =>
        expect.objectContaining({ code: "CLUSTER_SCOPE_CONFLICT" })
      ),
    });
    expect(started).toEqual([]);
  });
});
