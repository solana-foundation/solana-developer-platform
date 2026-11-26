import { describe, expect, it } from "vitest";
import { custodyClusterConfig } from "./cluster-config";

describe("custodyClusterConfig", () => {
  it("refuses to answer outside a cluster scope", () => {
    expect(() => custodyClusterConfig()).toThrow(
      expect.objectContaining({ code: "CLUSTER_SCOPE_MISSING" })
    );
  });
});
