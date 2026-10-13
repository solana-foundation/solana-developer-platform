import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ClusterScope, currentClusterScope, runInClusterScope } from "./scope";

type ScopeFacts = Parameters<typeof runInClusterScope>[0];

function readScopeAcross(facts: ScopeFacts, delaysMs: readonly number[]) {
  return runInClusterScope(facts, async () => {
    const seen: ClusterScope[] = [currentClusterScope()];
    for (const delayMs of delaysMs) {
      await delay(delayMs);
      seen.push(currentClusterScope());
    }
    return seen;
  });
}

describe("currentClusterScope", () => {
  it("refuses to read a scope outside any scope", () => {
    assert.throws(() => currentClusterScope(), {
      name: "SdpRpcError",
      message: "No cluster scope is open for this work",
      code: "CLUSTER_SCOPE_MISSING",
      statusCode: 500,
    });
  });
});

describe("runInClusterScope", () => {
  it("derives devnet for sandbox and mainnet-beta for production, frozen", () => {
    const sandbox = runInClusterScope(
      { projectId: "proj_scope_sandbox", environment: "sandbox" },
      currentClusterScope
    );
    const production = runInClusterScope(
      { projectId: null, environment: "production" },
      currentClusterScope
    );

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

  it("keeps each concurrent scope's facts across interleaved awaits", async () => {
    const alpha: ClusterScope = {
      projectId: "proj_scope_alpha",
      environment: "sandbox",
      cluster: "devnet",
    };
    const beta: ClusterScope = {
      projectId: "proj_scope_beta",
      environment: "production",
      cluster: "mainnet-beta",
    };

    const [alphaSeen, betaSeen] = await Promise.all([
      readScopeAcross({ projectId: "proj_scope_alpha", environment: "sandbox" }, [20, 0, 10]),
      readScopeAcross({ projectId: "proj_scope_beta", environment: "production" }, [0, 20, 0]),
    ]);

    assert.deepEqual(alphaSeen, [alpha, alpha, alpha, alpha]);
    assert.deepEqual(betaSeen, [beta, beta, beta, beta]);
  });

  it("runs a nested scope with equal facts under the outer scope", () => {
    const { outer, nested } = runInClusterScope(
      { projectId: "proj_scope_nested", environment: "sandbox" },
      () => ({
        outer: currentClusterScope(),
        nested: runInClusterScope(
          { projectId: "proj_scope_nested", environment: "sandbox" },
          currentClusterScope
        ),
      })
    );

    assert.equal(nested, outer);
  });

  it("refuses a nested scope with different facts without running it", () => {
    const operation = mock.fn(currentClusterScope);

    assert.throws(
      () =>
        runInClusterScope({ projectId: "proj_scope_conflict", environment: "sandbox" }, () =>
          runInClusterScope(
            { projectId: "proj_scope_conflict", environment: "production" },
            operation
          )
        ),
      {
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
      }
    );
    assert.equal(operation.mock.callCount(), 0);
  });
});
