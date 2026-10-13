import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SdpRpcError } from "@sdp/rpc/errors";
import { SdpEarnError } from "./errors";
import { assertRuntimeMatchesScope } from "./runtime-scope";
import { runInCatalogueScope } from "./test/cluster-pool";

describe("assertRuntimeMatchesScope", () => {
  it("refuses a production runtime inside a sandbox cluster scope, naming the provider", () => {
    assert.throws(
      () =>
        runInCatalogueScope("sandbox", () =>
          assertRuntimeMatchesScope({ env: {}, environment: "production" }, "Hastra")
        ),
      (error: unknown) =>
        error instanceof SdpEarnError &&
        error.code === "INTERNAL_ERROR" &&
        error.message === "Hastra was asked to run on production inside a sandbox cluster scope"
    );
  });

  it("returns for a runtime on the open scope's environment", () => {
    assert.doesNotThrow(() =>
      runInCatalogueScope("sandbox", () =>
        assertRuntimeMatchesScope({ env: {}, environment: "sandbox" }, "Hastra")
      )
    );
  });

  it("refuses a runtime when no cluster scope is open", () => {
    assert.throws(
      () => assertRuntimeMatchesScope({ env: {}, environment: "sandbox" }, "Hastra"),
      (error: unknown) => error instanceof SdpRpcError && error.code === "CLUSTER_SCOPE_MISSING"
    );
  });
});
