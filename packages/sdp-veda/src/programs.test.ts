import { type VedaDeployment, vedaDeployment } from "@sdp/types/veda-programs";
import { describe, expect, it } from "vitest";
import { toClusterConfig, vedaClusterConfig, vedaProgramAllowlist } from "./programs";

const VAULT_PROGRAM = "5J76xGGXn5op9S48pMqWV6Ex48ZxsKsRs4bGeDzSHEVc";
const QUEUE_PROGRAM = "Cchro8d7bN5Xfk77z9hJKxREJwSAjpz5K2seK4iNN396";
const HOOK_PROGRAM = "FSZPGBfPWb6fUQWSwiKv8de55NabpBWgPmB6RV7kDgv9";
const VAULT_STATE = "So11111111111111111111111111111111111111112";

const DEPLOYMENT: VedaDeployment = {
  vaultProgramAddress: VAULT_PROGRAM,
  queueProgramAddress: QUEUE_PROGRAM,
  hookProgramAddress: HOOK_PROGRAM,
  vaultStateAddresses: [VAULT_STATE],
};

describe("vedaClusterConfig", () => {
  /**
   * SDP has no confirmed Veda deployment on either cluster, so every build and
   * every position read fails closed. This is the state that changes — with
   * Veda's written confirmation — when `VEDA_DEPLOYMENTS` is filled in.
   */
  it("refuses a cluster SDP has no confirmed deployment for", () => {
    expect(vedaDeployment("devnet")).toBeNull();
    expect(vedaDeployment("mainnet-beta")).toBeNull();
    for (const cluster of ["devnet", "mainnet-beta"] as const) {
      expect(() => vedaClusterConfig(cluster)).toThrow(/no confirmed Veda deployment/);
    }
  });
});

describe("toClusterConfig", () => {
  it("brands every address and carries the cluster", () => {
    const config = toClusterConfig("devnet", DEPLOYMENT);
    expect(config.cluster).toBe("devnet");
    expect(String(config.vaultProgramAddress)).toBe(VAULT_PROGRAM);
    expect(String(config.queueProgramAddress)).toBe(QUEUE_PROGRAM);
    expect(String(config.hookProgramAddress)).toBe(HOOK_PROGRAM);
    expect(config.vaultStateAddresses.map(String)).toEqual([VAULT_STATE]);
  });

  it("omits the queue when a deployment declares none", () => {
    const { queueProgramAddress: _omitted, ...noQueue } = DEPLOYMENT;
    expect(toClusterConfig("devnet", noQueue).queueProgramAddress).toBeUndefined();
  });

  /**
   * A malformed address must fail HERE, at configuration time, rather than
   * inside the SDK after several RPC round trips — or worse, as an instruction
   * addressed somewhere unintended.
   */
  it("refuses an address that is not valid base58", () => {
    expect(() =>
      toClusterConfig("devnet", { ...DEPLOYMENT, vaultProgramAddress: "not-an-address" })
    ).toThrow(/not a valid Solana address/);
  });
});

describe("vedaProgramAllowlist", () => {
  const config = toClusterConfig("devnet", DEPLOYMENT);
  const allowed = vedaProgramAllowlist(config);

  it("admits this deployment's own programs", () => {
    for (const program of [VAULT_PROGRAM, QUEUE_PROGRAM, HOOK_PROGRAM]) {
      expect(allowed.has(program)).toBe(true);
    }
  });

  it("admits the cluster-invariant programs a deposit actually touches", () => {
    for (const program of [
      "11111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    ]) {
      expect(allowed.has(program), program).toBe(true);
    }
  });

  /**
   * A CLOSED set, not a denylist: the failure being guarded against is an
   * instruction quietly addressed to something this deployment never named,
   * and only enumerating what is permitted catches that.
   */
  it("admits nothing else", () => {
    expect(allowed.has("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd")).toBe(false);
    expect(allowed.has(VAULT_STATE)).toBe(false);
  });

  it("does not admit a queue the deployment does not declare", () => {
    const { queueProgramAddress: _omitted, ...noQueue } = DEPLOYMENT;
    expect(vedaProgramAllowlist(toClusterConfig("devnet", noQueue)).has(QUEUE_PROGRAM)).toBe(false);
  });
});
