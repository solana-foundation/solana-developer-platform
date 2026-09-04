import * as solanaRpc from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import {
  assertClusterEndpoint,
  CLUSTER_ENDPOINT_PROOF_TTL_MS,
  resetClusterEndpointProofs,
  resolveClusterRpcUrl,
  resolveVaultDirectClient,
} from "./execution-registry";
import { createVaultDeadline } from "./vault-deadline";

const env = {} as Env;
const rpcUrl = "https://rpc.example.invalid";
const executionEnv = { SOLANA_DEVNET_RPC_URL: rpcUrl } as Env;
const runtime = { env: {}, environment: "sandbox" } as const;
const depositInput = {
  providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  owner: "11111111111111111111111111111112",
  amount: "1",
};

function mockGenesisSend() {
  const send = vi.fn();
  vi.spyOn(solanaRpc, "createRpc").mockReturnValue({
    getGenesisHash: () => ({ send }),
  } as never);
  return send;
}

beforeEach(() => {
  resetClusterEndpointProofs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("assertClusterEndpoint", () => {
  it("evicts a transient probe rejection so the endpoint can recover", async () => {
    const send = mockGenesisSend()
      .mockRejectedValueOnce(new Error("RPC request timed out after 30000ms"))
      .mockResolvedValue(GENESIS_HASH_BY_CLUSTER.devnet);

    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).rejects.toThrow(/Could not verify/);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();
    // The successful observation is cached only for the short trust window.
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("caches an observed mismatch only within the short trust window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    const send = mockGenesisSend().mockResolvedValue(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);

    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).rejects.toThrow(/reports genesis/);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).rejects.toThrow(/reports genesis/);
    expect(send).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(CLUSTER_ENDPOINT_PROOF_TTL_MS);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).rejects.toThrow(/reports genesis/);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent probes and caches the successful observation", async () => {
    let resolveGenesis!: (hash: string) => void;
    const send = mockGenesisSend().mockReturnValue(
      new Promise<string>((resolve) => {
        resolveGenesis = resolve;
      })
    );

    const first = assertClusterEndpoint(env, "devnet", rpcUrl);
    const second = assertClusterEndpoint(env, "devnet", rpcUrl);
    expect(send).toHaveBeenCalledOnce();

    resolveGenesis(GENESIS_HASH_BY_CLUSTER.devnet);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledOnce();
  });

  it("re-proves a successful URL after its trust window expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00.000Z"));
    const send = mockGenesisSend().mockResolvedValue(GENESIS_HASH_BY_CLUSTER.devnet);

    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();
    vi.advanceTimersByTime(CLUSTER_ENDPOINT_PROOF_TTL_MS - 1);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    await expect(assertClusterEndpoint(env, "devnet", rpcUrl)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("resolveClusterRpcUrl", () => {
  it("prefers an explicit per-cluster endpoint", () => {
    expect(
      resolveClusterRpcUrl(
        {
          SOLANA_NETWORK: "devnet",
          SOLANA_RPC_URL: "https://public.example.invalid",
          SOLANA_DEVNET_RPC_URL: " https://earn-devnet.example.invalid ",
        } as Env,
        "devnet"
      )
    ).toBe("https://earn-devnet.example.invalid");
  });

  it("preserves the canonical managed-provider selection and API-key expansion", () => {
    expect(
      resolveClusterRpcUrl(
        {
          SOLANA_NETWORK: "devnet",
          SOLANA_RPC_URL: "https://public.example.invalid",
          SOLANA_RPC_DEFAULT_PROVIDER: "helius",
          SOLANA_RPC_HELIUS_URL: "https://helius.example.invalid/?api-key={API_KEY}",
          SOLANA_RPC_HELIUS_API_KEY: "secret key",
        } as Env,
        "devnet"
      )
    ).toBe("https://helius.example.invalid/?api-key=secret%20key");
  });

  it("does not reuse a canonical default for the other cluster", () => {
    expect(
      resolveClusterRpcUrl(
        {
          SOLANA_NETWORK: "devnet",
          SOLANA_RPC_URL: "https://devnet.example.invalid",
        } as Env,
        "mainnet-beta"
      )
    ).toBe("");
  });
});

describe("resolveVaultDirectClient", () => {
  it("keeps resolution I/O-free and preserves inherited provider capabilities", () => {
    const createRpc = vi.spyOn(solanaRpc, "createRpc");

    const client = resolveVaultDirectClient(executionEnv, "kamino", createVaultDeadline());

    expect(client).not.toBeNull();
    expect(typeof (client as unknown as Record<string, unknown>).listStrategyMetrics).toBe(
      "function"
    );
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("resolves an executing client for every provider that can move money", () => {
    const createRpc = vi.spyOn(solanaRpc, "createRpc");

    for (const provider of ["kamino", "veda"]) {
      const client = resolveVaultDirectClient(executionEnv, provider, createVaultDeadline());
      expect(client, provider).not.toBeNull();
      expect(client?.provider, provider).toBe(provider);
      // The superset, not a replacement: the executing client still catalogues.
      expect(typeof client?.listStrategies, provider).toBe("function");
    }
    expect(createRpc).not.toHaveBeenCalled();
  });

  /**
   * This resolver is the ONE sanctioned provider-id branch in the codebase, and
   * unknown ids must answer null rather than throw: a strategy row written by a
   * newer deploy would otherwise 500 a read that merely touched it.
   */
  it("answers null for anything this deployment cannot execute", () => {
    for (const provider of ["ground", "upshift", "perena", "not-a-provider", "__proto__", ""]) {
      expect(
        resolveVaultDirectClient(executionEnv, provider, createVaultDeadline()),
        provider
      ).toBeNull();
    }
  });

  /**
   * SDP has no confirmed PRODUCTION Veda deployment (devnet is deployed;
   * mainnet waits on PRO-1777), so a production deposit fails on THAT rather
   * than on an RPC — and it fails before any endpoint work, because an
   * unconfigured deployment is a fact about SDP that should not depend on a
   * node being reachable.
   */
  it("refuses Veda work on the missing mainnet deployment, before any RPC", async () => {
    const createRpc = vi.spyOn(solanaRpc, "createRpc");
    const productionRuntime = { env: {}, environment: "production" } as const;
    const client = resolveVaultDirectClient(executionEnv, "veda", createVaultDeadline());
    if (!client) throw new Error("expected a Veda vault-direct client");

    await expect(
      client.buildVaultDeposit(productionRuntime, { ...depositInput, minSharesOut: "1" })
    ).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_CONFIGURED" });
    await expect(
      client.readVaultPositions(productionRuntime, {
        owner: depositInput.owner,
        providerReferences: [depositInput.providerReference],
      })
    ).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_CONFIGURED" });
    expect(createRpc).not.toHaveBeenCalled();
  });

  it("refuses build and position work before the SDK when genesis is wrong", async () => {
    mockGenesisSend().mockResolvedValue(GENESIS_HASH_BY_CLUSTER["mainnet-beta"]);
    const client = resolveVaultDirectClient(executionEnv, "kamino", createVaultDeadline());
    expect(client).not.toBeNull();
    if (!client) throw new Error("expected Kamino vault-direct client");

    await expect(client.buildVaultDeposit(runtime, depositInput)).rejects.toThrow(
      /reports genesis/
    );
    await expect(
      client.readVaultPositions(runtime, {
        owner: depositInput.owner,
        providerReferences: [depositInput.providerReference],
      })
    ).rejects.toThrow(/reports genesis/);
  });

  it("does not start provider work after endpoint proof exhausts the shared deadline", async () => {
    vi.useFakeTimers();
    mockGenesisSend().mockReturnValue(new Promise<never>(() => undefined));
    const client = resolveVaultDirectClient(executionEnv, "kamino", createVaultDeadline(25));
    expect(client).not.toBeNull();
    if (!client) throw new Error("expected Kamino vault-direct client");

    const result = client.buildVaultDeposit(runtime, depositInput);
    const rejection = expect(result).rejects.toThrow(
      "Building the vault deposit timed out after 25ms"
    );
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });
});
