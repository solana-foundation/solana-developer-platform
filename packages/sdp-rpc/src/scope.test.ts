import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ClusterScope, clusterScope, currentClusterScope, withCluster } from "./scope";

function readScopeAcross(scope: ClusterScope, delaysMs: readonly number[]) {
  return withCluster(scope, async () => {
    const seen: ClusterScope[] = [currentClusterScope()];
    for (const delayMs of delaysMs) {
      await delay(delayMs);
      seen.push(currentClusterScope());
    }
    return seen;
  });
}

describe("clusterScope", () => {
  it("derives devnet for sandbox and mainnet-beta for production, frozen", () => {
    const sandbox = clusterScope({ projectId: "proj_scope_sandbox", environment: "sandbox" });
    const production = clusterScope({ projectId: null, environment: "production" });

    assert.deepEqual(sandbox, {
      projectId: "proj_scope_sandbox",
      environment: "sandbox",
      cluster: "devnet",
    });
    assert.deepEqual(production, {
      projectId: null,
      environment: "production",
      cluster: "mainnet-beta",
    });
    assert.ok(Object.isFrozen(sandbox));
    assert.ok(Object.isFrozen(production));
  });
});

describe("withCluster", () => {
  it("refuses to read a scope outside any scope", () => {
    assert.throws(() => currentClusterScope(), {
      name: "SdpRpcError",
      message: "No cluster scope is open for this work",
      code: "CLUSTER_SCOPE_MISSING",
      statusCode: 500,
    });
  });

  it("keeps each concurrent scope's facts across interleaved awaits", async () => {
    const alpha = clusterScope({ projectId: "proj_scope_alpha", environment: "sandbox" });
    const beta = clusterScope({ projectId: "proj_scope_beta", environment: "production" });

    const [alphaSeen, betaSeen] = await Promise.all([
      readScopeAcross(alpha, [20, 0, 10]),
      readScopeAcross(beta, [0, 20, 0]),
    ]);

    assert.deepEqual(alphaSeen, [alpha, alpha, alpha, alpha]);
    assert.deepEqual(betaSeen, [beta, beta, beta, beta]);
  });

  it("runs a nested scope with equal facts under the outer scope", () => {
    const outer = clusterScope({ projectId: "proj_scope_nested", environment: "sandbox" });
    const equal = clusterScope({ projectId: "proj_scope_nested", environment: "sandbox" });

    assert.equal(
      withCluster(outer, () => withCluster(equal, currentClusterScope)),
      outer
    );
  });

  it("refuses a nested scope with different facts without running it", () => {
    const outer = clusterScope({ projectId: "proj_scope_conflict", environment: "sandbox" });
    const conflicting = clusterScope({
      projectId: "proj_scope_conflict",
      environment: "production",
    });
    const operation = mock.fn(currentClusterScope);

    assert.throws(() => withCluster(outer, () => withCluster(conflicting, operation)), {
      name: "SdpRpcError",
      message: "A cluster scope with different facts is already open",
      code: "CLUSTER_SCOPE_CONFLICT",
      statusCode: 500,
      details: {
        openProjectId: "proj_scope_conflict",
        openEnvironment: "sandbox",
        requestedProjectId: "proj_scope_conflict",
        requestedEnvironment: "production",
      },
    });
    assert.equal(operation.mock.callCount(), 0);
  });
});
