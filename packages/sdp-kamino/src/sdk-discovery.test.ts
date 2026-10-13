import { createEndpointRpc } from "@sdp/rpc/factory";
import { DEFAULT_RPC_REQUEST_TIMEOUT_MS } from "@sdp/rpc/solana";
import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kaminoClusterConfig } from "./programs";
import { discoverKaminoPositionVaults } from "./sdk";
import type { KaminoRuntime } from "./types";

const mocks = vi.hoisted(() => ({
  constructVaultClient: vi.fn(),
  getUserSharesBalanceAllVaults: vi.fn(),
}));

vi.mock("@kamino-finance/klend-sdk", () => ({
  KaminoVault: class {},
  KaminoVaultClient: class {
    constructor(...args: unknown[]) {
      mocks.constructVaultClient(...args);
    }

    getUserSharesBalanceAllVaults(...args: unknown[]) {
      return mocks.getUserSharesBalanceAllVaults(...args);
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discoverKaminoPositionVaults", () => {
  const owner = address("11111111111111111111111111111112");
  const runtime: KaminoRuntime = {
    cluster: "devnet",
    rpc: createEndpointRpc("https://devnet.kamino-discovery.test", {
      timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS,
    }),
    readRpc: createEndpointRpc("https://devnet.kamino-discovery-reads.test", {
      timeoutMs: DEFAULT_RPC_REQUEST_TIMEOUT_MS,
    }),
  };

  it("uses the cluster-bound all-vault census and returns only its candidate keys", async () => {
    const vaults = [
      address("7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx"),
      address("So11111111111111111111111111111111111111112"),
    ];
    // The values are intentionally unusable: discovery must never trust the
    // SDK's lossy uiAmount-derived balances, only the vault-address keys.
    mocks.getUserSharesBalanceAllVaults.mockResolvedValue(
      new Map(vaults.map((vault) => [vault, { unsafeBalance: Symbol("do-not-read") }]))
    );

    await expect(discoverKaminoPositionVaults(runtime, owner)).resolves.toEqual(vaults);

    const config = kaminoClusterConfig("devnet");
    expect(mocks.constructVaultClient).toHaveBeenCalledWith(
      runtime.rpc,
      config.slotDurationMs,
      config.kvaultProgramId,
      config.klendProgramId,
      undefined,
      config.farmsProgramId
    );
    expect(mocks.getUserSharesBalanceAllVaults).toHaveBeenCalledWith(owner);
  });

  it("fails closed when the on-chain holdings census is unreadable", async () => {
    const cause = new Error("rpc unavailable");
    mocks.getUserSharesBalanceAllVaults.mockRejectedValue(cause);

    await expect(discoverKaminoPositionVaults(runtime, owner)).rejects.toMatchObject({
      name: "SdpKaminoError",
      code: "VAULT_UNREADABLE",
      cause,
    });
  });
});
