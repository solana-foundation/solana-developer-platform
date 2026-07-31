import { PrivateChannelError } from "@sdp/private-channels";
import { isUnauthorizedRpcError } from "@sdp/rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import type { SpcAuthContext } from "./gateway-auth";

// Mock the packages whose runtime graph doesn't resolve in the node pool. gateway-auth
// imports SolanaRpc as a TYPE only, so @sdp/rpc/solana is never loaded here; the
// isUnauthorizedRpcError (@sdp/rpc) IS used so the 401 classification is exercised end-to-end.
const { createChannelGatewayRpc } = vi.hoisted(() => ({
  // Return a sentinel identifying which token the rpc was built with.
  createChannelGatewayRpc: vi.fn(
    (_env: unknown, url: string, opts?: { headers?: Record<string, string> }) => ({
      url,
      authorization: opts?.headers?.Authorization,
    })
  ),
}));
vi.mock("@sdp/private-channels", () => ({
  createChannelGatewayRpc,
  PrivateChannelError: class PrivateChannelError extends Error {
    constructor(
      public readonly code: string,
      message?: string
    ) {
      super(message ?? code);
      this.name = "PrivateChannelError";
    }
  },
}));
vi.mock("@sdp/private-channels/auth", () => ({ createAuthClient: vi.fn() }));
vi.mock("@/db/repositories", () => ({
  createPrivateChannelInstanceRepository: vi.fn(),
  createPrivateChannelUserRepository: vi.fn(),
  createPrivateChannelVerifiedWalletRepository: vi.fn(),
}));

import { withGatewayRpc, withSpcAuth } from "./gateway-auth";

const ENV = {} as Env;
const URL = "https://gw.example";

/** The token sentinel our mocked createChannelGatewayRpc returns in place of a SolanaRpc. */
type FakeRpc = { url: string; authorization?: string };

/** A 401 in the shape @solana/kit's HTTP transport throws. */
function http401() {
  return { context: { statusCode: 401 } };
}
function http403() {
  return { context: { statusCode: 403 } };
}

function context(
  current: string,
  refreshTo?: string
): SpcAuthContext & { refresh: ReturnType<typeof vi.fn> } {
  const c = {
    current,
    refresh: vi.fn(async () => {
      c.current = refreshTo ?? "refreshed";
      return c.current;
    }),
    pcUserId: "pcu_test",
  };
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("withGatewayRpc", () => {
  it("passes the current token through and does not refresh on success", async () => {
    const h = context("tok-1");
    const run = vi.fn(async (rpc: unknown) => (rpc as FakeRpc).authorization);

    const result = await withGatewayRpc(ENV, URL, h, run);

    expect(result).toBe("Bearer tok-1");
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("on a 401 refreshes once and retries with the new token", async () => {
    const h = context("stale", "fresh");
    const run = vi.fn(async (rpc: unknown) => {
      const { authorization } = rpc as FakeRpc;
      if (authorization === "Bearer stale") throw http401();
      return authorization;
    });

    const result = await withGatewayRpc(ENV, URL, h, run);

    expect(result).toBe("Bearer fresh");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on a 403 (valid token, not permitted)", async () => {
    const h = context("tok");
    const run = vi.fn(async () => {
      throw http403();
    });

    await expect(withGatewayRpc(ENV, URL, h, run)).rejects.toEqual(http403());
    expect(h.refresh).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries at most once — a persistent 401 propagates", async () => {
    const h = context("stale", "fresh");
    const run = vi.fn(async () => {
      throw http401();
    });

    await expect(withGatewayRpc(ENV, URL, h, run)).rejects.toEqual(http401());
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("surfaces a refresh() failure (e.g. login unavailable) instead of the 401", async () => {
    const h = context("stale");
    h.refresh.mockRejectedValueOnce(new Error("auth unavailable"));
    const run = vi.fn(async () => {
      throw http401();
    });

    await expect(withGatewayRpc(ENV, URL, h, run)).rejects.toThrow("auth unavailable");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("withSpcAuth", () => {
  it("passes the current token through and does not refresh on success", async () => {
    const h = context("tok-1");
    const run = vi.fn(async (token: string) => token);

    const result = await withSpcAuth(h, run);

    expect(result).toBe("tok-1");
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("on UNAUTHORIZED refreshes once and retries with the new token", async () => {
    const h = context("stale", "fresh");
    const run = vi.fn(async (token: string) => {
      if (token === "stale") throw new PrivateChannelError("UNAUTHORIZED", "bad token");
      return token;
    });

    const result = await withSpcAuth(h, run);

    expect(result).toBe("fresh");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on FORBIDDEN / CONFLICT / AUTH_UNAVAILABLE", async () => {
    for (const code of ["FORBIDDEN", "CONFLICT", "AUTH_UNAVAILABLE"] as const) {
      const h = context("tok");
      const err = new PrivateChannelError(code, code);
      const run = vi.fn(async () => {
        throw err;
      });

      await expect(withSpcAuth(h, run)).rejects.toBe(err);
      expect(h.refresh).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("does NOT retry on a plain Error", async () => {
    const h = context("tok");
    const run = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(withSpcAuth(h, run)).rejects.toThrow("boom");
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("retries at most once — a persistent UNAUTHORIZED propagates", async () => {
    const h = context("stale", "fresh");
    const run = vi.fn(async () => {
      throw new PrivateChannelError("UNAUTHORIZED", "still bad");
    });

    await expect(withSpcAuth(h, run)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("surfaces a refresh() failure instead of the original UNAUTHORIZED", async () => {
    const h = context("stale");
    h.refresh.mockRejectedValueOnce(new Error("auth unavailable"));
    const run = vi.fn(async () => {
      throw new PrivateChannelError("UNAUTHORIZED", "bad token");
    });

    await expect(withSpcAuth(h, run)).rejects.toThrow("auth unavailable");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("isUnauthorizedRpcError", () => {
  it("is true only for a 401 on a SolanaError-shaped context", () => {
    expect(isUnauthorizedRpcError({ context: { statusCode: 401 } })).toBe(true);
  });

  it("is false for 403 / 500 / transient / non-object errors", () => {
    expect(isUnauthorizedRpcError({ context: { statusCode: 403 } })).toBe(false);
    expect(isUnauthorizedRpcError({ context: { statusCode: 500 } })).toBe(false);
    expect(isUnauthorizedRpcError(new Error("503 Service Unavailable"))).toBe(false);
    expect(isUnauthorizedRpcError(null)).toBe(false);
    expect(isUnauthorizedRpcError("401")).toBe(false);
  });
});
