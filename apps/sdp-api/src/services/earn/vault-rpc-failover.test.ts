import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseJsonRpcRequest } from "@/test/helpers/cluster-rpc";
import { assertClusterEndpoint } from "./cluster-rpc";
import { createVaultDeadline } from "./vault-deadline";
import { createVaultRpcFailover } from "./vault-rpc-failover";

const runtime = { env: {}, environment: "sandbox" } as const;

let poolSequence = 0;
let primary = "";
let fallback = "";
/** Every genesis probe of the current test, by endpoint, in arrival order. */
const probedUrls: string[] = [];
const genesisFor = vi.fn<(url: string) => string>();

/**
 * Point the devnet managed pool at two endpoints no earlier test proved (the
 * pool's genesis proofs outlive a test) and answer each probe with
 * `genesisFor(url)`.
 */
beforeEach(() => {
  poolSequence += 1;
  primary = `https://primary-${poolSequence}.failover.test`;
  fallback = `https://fallback-${poolSequence}.failover.test`;
  vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", primary);
  vi.stubEnv("SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL", fallback);
  probedUrls.length = 0;
  genesisFor.mockReset().mockReturnValue(GENESIS_HASH_BY_CLUSTER.devnet);
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { id, method } = parseJsonRpcRequest(init);
    if (method !== "getGenesisHash") throw new Error(`Unexpected ${method}`);
    const url = String(input);
    probedUrls.push(url);
    return Response.json({ jsonrpc: "2.0", id, result: genesisFor(url) });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The shape Veda and Kamino position reads throw: failures sit in `.errors`. */
function fanOutFailure(...causes: Error[]): Error {
  return new Error(`Could not read ${causes.length} vault positions`, {
    cause: new AggregateError(
      causes.map((cause, index) => new Error(`Vault ${index} read failed`, { cause })),
      "Vault position reads failed"
    ),
  });
}

describe("Earn RPC fallback", () => {
  it("retries a nested provider transport failure on a separately proven endpoint", async () => {
    const rpc = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);
    const visited: string[] = [];
    const result = await rpc.run("Read vault", async () => {
      const url = await rpc.resolve(runtime, "devnet");
      visited.push(url);
      if (url === primary)
        throw new Error("Vault unreadable", { cause: new Error("fetch failed") });
      return "verified vault state";
    });
    expect(result).toBe("verified vault state");
    expect(visited).toEqual([primary, fallback]);
    expect(probedUrls).toEqual([primary, fallback]);
  });

  it("fails over past a primary whose genesis probe answers node-unhealthy", async () => {
    // A code-classified failure: its message matches no transient text, so only the probe
    // error kept as the cause tells the failover that the next endpoint could succeed.
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { id, method } = parseJsonRpcRequest(init);
      if (method !== "getGenesisHash") throw new Error(`Unexpected ${method}`);
      const url = String(input);
      probedUrls.push(url);
      if (url === primary) {
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32005, message: "Node is unhealthy", data: { numSlotsBehind: 900 } },
        });
      }
      return Response.json({ jsonrpc: "2.0", id, result: genesisFor(url) });
    });
    const rpc = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);
    const visited: string[] = [];

    const result = await rpc.run("Read vault", async () => {
      const url = await rpc.resolve(runtime, "devnet");
      visited.push(url);
      return "verified vault state";
    });

    expect(result).toBe("verified vault state");
    expect(visited).toEqual([fallback]);
    expect(probedUrls).toEqual([primary, fallback]);
  });

  it("draws only the requested cluster's pool, never the process default", async () => {
    vi.stubEnv("SOLANA_NETWORK", "devnet");
    vi.stubEnv("SOLANA_RPC_URL", "https://process-default.failover.test");
    const rpc = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);

    await expect(
      rpc.run("Read vault", () =>
        rpc.resolve({ ...runtime, environment: "production" }, "mainnet-beta")
      )
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      message: expect.stringContaining("SOLANA_RPC_<PROVIDER>_MAINNET_API_KEY_URL"),
    });
    expect(probedUrls).toEqual([]);
  });

  it("retries a per-vault fan-out whose every failure is transient", async () => {
    const rpc = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);
    const visited: string[] = [];
    const result = await rpc.run("Read vault positions", async () => {
      const url = await rpc.resolve(runtime, "devnet");
      visited.push(url);
      if (url === primary)
        throw fanOutFailure(
          new TypeError("fetch failed", { cause: new Error("other side closed") }),
          new Error("HTTP error (429): Too Many Requests")
        );
      return "verified vault state";
    });
    expect(result).toBe("verified vault state");
    expect(visited).toEqual([primary, fallback]);
  });

  const cyclic = new Error("Vault unreadable");
  cyclic.cause = cyclic;
  it.each([
    [
      "a fan-out with one deterministic failure",
      fanOutFailure(new TypeError("fetch failed"), new Error("Vault account does not exist")),
    ],
    [
      "an empty fan-out",
      new Error("Vault unreadable", { cause: new AggregateError([], "No reads ran") }),
    ],
    ["a cyclic cause chain", cyclic],
  ])("does not retry %s", async (_label, failure) => {
    const rpc = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);
    const read = vi.fn(async () => {
      await rpc.resolve(runtime, "devnet");
      throw failure;
    });
    await expect(rpc.run("Read vault positions", read)).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("never reads/builds on a fallback that reports the wrong cluster", async () => {
    genesisFor.mockImplementation(
      (url) => GENESIS_HASH_BY_CLUSTER[url === primary ? "devnet" : "mainnet-beta"]
    );
    const rpc = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);
    const read = vi.fn(async () => {
      await rpc.resolve(runtime, "devnet");
      throw new Error("503 service unavailable");
    });
    await expect(rpc.run("Read vault", read)).rejects.toThrow(/reports genesis/);
    expect(read).toHaveBeenCalledTimes(2);
    expect(probedUrls).toEqual([primary, fallback]);
  });

  it("does not retain the fallback for later historical reads or reinterpret absent evidence", async () => {
    const rpc = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);
    await rpc.run("Build", async () => {
      if ((await rpc.resolve(runtime, "devnet")) === primary) throw new Error("fetch failed");
    });
    const visited: string[] = [];
    const evidence = await rpc.run("Read receipt", async () => {
      visited.push(await rpc.resolve(runtime, "devnet"));
      return null;
    });
    expect(evidence).toBeNull();
    expect(visited).toEqual([primary]);
  });

  it("does not retry a deterministic refusal or past a one-endpoint pool", async () => {
    vi.stubEnv("SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL", "");
    const single = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);
    const read = vi.fn(async () => {
      await single.resolve(runtime, "devnet");
      throw new Error("fetch failed");
    });
    await expect(single.run("Read vault", read)).rejects.toThrow("fetch failed");
    expect(read).toHaveBeenCalledTimes(1);

    vi.stubEnv("SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL", fallback);
    const pooled = createVaultRpcFailover(createVaultDeadline(), assertClusterEndpoint);
    const refused = vi.fn(async () => {
      await pooled.resolve(runtime, "devnet");
      throw new Error("Insufficient funds");
    });
    await expect(pooled.run("Build", refused)).rejects.toThrow("Insufficient funds");
    expect(refused).toHaveBeenCalledTimes(1);
  });
});
