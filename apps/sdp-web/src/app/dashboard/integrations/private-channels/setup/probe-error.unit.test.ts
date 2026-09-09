import type { ConnectionProbeResult } from "@sdp/private-channels";
import { describe, expect, it } from "vitest";
import { isProjectRpcProbeFailure, summarizeProbeFailure } from "./probe-error";

function probe(rpc: ConnectionProbeResult["rpc"]): ConnectionProbeResult {
  return {
    ok: false,
    gateway: {
      status: "ready",
      latencyMs: 10,
      health: { status: 200, ok: true },
      ready: { status: 200, ok: true },
    },
    auth: { ok: true, latencyMs: 10 },
    rpc,
  };
}

describe("Private Channels probe errors", () => {
  it("directs project RPC failures to the project integration and deployment", () => {
    const result = probe({ ok: false, latencyMs: 10, error: "Program not found." });

    expect(isProjectRpcProbeFailure(result)).toBe(true);
    expect(summarizeProbeFailure(result)).toBe(
      "Project RPC check failed: Program not found. Fix the project's RPC integration or escrow deployment and try again."
    );
  });

  it("does not mislabel a healthy project RPC when another endpoint fails", () => {
    const result = probe({ ok: true, latencyMs: 10, version: "1.18.4" });

    expect(isProjectRpcProbeFailure(result)).toBe(false);
  });
});
