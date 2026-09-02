import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { describe, expect, it, vi } from "vitest";
import { probeProjectRpcDeployment } from "./project-rpc";

const OTHER_OWNER = "11111111111111111111111111111111";

interface AccountShape {
  executable: boolean;
  owner: string;
}

function rpcWithAccounts(input?: {
  program?: AccountShape | null;
  instance?: AccountShape | null;
  version?: string;
}): SolanaRpc {
  const program =
    input && "program" in input ? input.program : { executable: true, owner: OTHER_OWNER };
  const instance =
    input && "instance" in input
      ? input.instance
      : { executable: false, owner: SANDBOX_DEFAULTS.escrowProgramId };

  return {
    getVersion: () => ({
      send: vi.fn().mockResolvedValue({ "solana-core": input?.version ?? "1.18.4" }),
    }),
    getAccountInfo: (address: { toString(): string }) => ({
      send: vi.fn().mockResolvedValue({
        value: address.toString() === SANDBOX_DEFAULTS.escrowProgramId ? program : instance,
      }),
    }),
  } as unknown as SolanaRpc;
}

const deployment = {
  escrowProgramId: SANDBOX_DEFAULTS.escrowProgramId,
  escrowInstanceAddr: SANDBOX_DEFAULTS.escrowInstanceAddr,
};

describe("probeProjectRpcDeployment", () => {
  it("preserves the legacy connectivity-only probe when no deployment is supplied", async () => {
    const getAccountInfo = vi.fn();
    const rpc = {
      getVersion: () => ({
        send: vi.fn().mockResolvedValue({ "solana-core": "1.18.4" }),
      }),
      getAccountInfo,
    } as unknown as SolanaRpc;

    const result = await probeProjectRpcDeployment(rpc, "devnet");

    expect(result).toMatchObject({ ok: true, version: "1.18.4" });
    expect(getAccountInfo).not.toHaveBeenCalled();
  });

  it("accepts an executable program and an instance owned by it", async () => {
    const result = await probeProjectRpcDeployment(rpcWithAccounts(), "devnet", deployment);

    expect(result).toMatchObject({ ok: true, version: "1.18.4" });
  });

  it("rejects a project RPC where the escrow program is missing", async () => {
    const result = await probeProjectRpcDeployment(
      rpcWithAccounts({ program: null }),
      "devnet",
      deployment
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Escrow program is not deployed on devnet.",
    });
  });

  it("rejects a non-executable escrow program account", async () => {
    const result = await probeProjectRpcDeployment(
      rpcWithAccounts({ program: { executable: false, owner: OTHER_OWNER } }),
      "devnet",
      deployment
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Escrow program is not executable on devnet.",
    });
  });

  it("rejects a project RPC where the escrow instance is missing", async () => {
    const result = await probeProjectRpcDeployment(
      rpcWithAccounts({ instance: null }),
      "devnet",
      deployment
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Escrow instance was not found on devnet.",
    });
  });

  it("rejects an escrow instance owned by another program", async () => {
    const result = await probeProjectRpcDeployment(
      rpcWithAccounts({ instance: { executable: false, owner: OTHER_OWNER } }),
      "mainnet-beta",
      deployment
    );

    expect(result).toMatchObject({
      ok: false,
      error: "Escrow instance is not owned by the configured escrow program on mainnet-beta.",
    });
  });
});
