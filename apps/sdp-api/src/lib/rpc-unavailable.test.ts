import { RpcUnavailableError, SdpRpcError } from "@sdp/rpc/errors";
import { runInClusterScope } from "@sdp/rpc/scope";
import { describe, expect, it } from "vitest";
import { fetchFailedError, rpcHttpError } from "@/test/helpers/rpc-errors";
import { rethrowRpcUnavailable } from "./rpc-unavailable";

const SANDBOX = { projectId: "proj_rpc_unavailable", environment: "sandbox" } as const;

describe("rethrowRpcUnavailable", () => {
  it("rethrows an unavailable RPC as it is", () => {
    const notConfigured = new RpcUnavailableError("not_configured", "No RPC endpoint", {
      cluster: "devnet",
    });
    const overloaded = rpcHttpError(503);

    expect(() => rethrowRpcUnavailable(notConfigured)).toThrow(notConfigured);
    expect(() => rethrowRpcUnavailable(overloaded)).toThrow(overloaded);
  });

  it("turns a bare network error into upstream_unavailable for the scope's cluster", () => {
    const unreachable = fetchFailedError();

    let thrown: unknown;
    try {
      runInClusterScope(SANDBOX, () => rethrowRpcUnavailable(unreachable));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RpcUnavailableError);
    expect(thrown).toMatchObject({
      reason: "upstream_unavailable",
      cluster: "devnet",
      cause: unreachable,
    });
  });

  it("leaves a persistent RPC failure to the route", () => {
    expect(() => rethrowRpcUnavailable(rpcHttpError(401))).not.toThrow();
    expect(() => rethrowRpcUnavailable(new Error("invalid mint data"))).not.toThrow();
    expect(() =>
      rethrowRpcUnavailable(new SdpRpcError("BAD_REQUEST", "bad address"))
    ).not.toThrow();
  });
});
