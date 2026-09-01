import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { planInstructionCount, planProgramAddresses } from "./guards";
import { toClusterConfig } from "./programs";
import { assertVedaVaultUsable, buildVedaDepositPlan, readVedaPosition } from "./sdk";
import type { VedaRuntime } from "./types";

/**
 * On-chain smoke test. **Opt-in, and never runs in CI** — every other test in
 * this package is pure and offline, per the repo rule that package tests touch
 * no network.
 *
 * It is also the ONLY thing in this repository that can prove the Veda
 * integration works end to end. It takes its deployment from the environment
 * rather than `VEDA_DEPLOYMENTS`, so it can exercise a candidate deployment
 * (mainnet, when Veda names a production vault) before it is committed.
 *
 *   VEDA_SMOKE_RPC_URL=https://api.devnet.solana.com \
 *   VEDA_SMOKE_VAULT_PROGRAM=<address> \
 *   VEDA_SMOKE_QUEUE_PROGRAM=<address> \
 *   VEDA_SMOKE_HOOK_PROGRAM=<address> \
 *   VEDA_SMOKE_VAULT=<vault-state address> \
 *   VEDA_SMOKE_OWNER=<any wallet address> \
 *   pnpm --filter @sdp/veda test
 *
 * Run it INSIDE the toolchain container, like every other node command in this
 * repository, and against DEVNET. Nothing here signs or submits — it builds an
 * unsigned plan and reads state — but Veda's own integration checklist requires
 * their separate approval for any value-moving mainnet test, and
 * `VAULT_DIRECT_DEPOSIT_ENVIRONMENTS` is sandbox-only for the same reason.
 *
 * What this proves that the offline tests cannot: the deployment validates, the
 * vault's PDAs derive as the SDK expects, a deposit plan actually builds against
 * live vault state, and every program it names is one the allowlist admits.
 */
const RPC_URL = process.env.VEDA_SMOKE_RPC_URL;
const VAULT_PROGRAM = process.env.VEDA_SMOKE_VAULT_PROGRAM;
const HOOK_PROGRAM = process.env.VEDA_SMOKE_HOOK_PROGRAM;
const VAULT = process.env.VEDA_SMOKE_VAULT;
const OWNER = process.env.VEDA_SMOKE_OWNER;

const configured = Boolean(RPC_URL && VAULT_PROGRAM && HOOK_PROGRAM && VAULT && OWNER);

describe.skipIf(!configured)("Veda plans against a live chain", () => {
  // Everything is resolved LAZILY: `describe.skipIf` still evaluates this
  // callback, so branding an empty address at suite scope would fail collection
  // for everyone rather than skipping quietly.
  const runtime = (): VedaRuntime => ({ cluster: "devnet", rpcUrl: RPC_URL ?? "" });
  const config = () =>
    toClusterConfig("devnet", {
      vaultProgramAddress: VAULT_PROGRAM ?? "",
      ...(process.env.VEDA_SMOKE_QUEUE_PROGRAM
        ? { queueProgramAddress: process.env.VEDA_SMOKE_QUEUE_PROGRAM }
        : {}),
      hookProgramAddress: HOOK_PROGRAM ?? "",
      vaultStateAddresses: [VAULT ?? ""],
    });
  const vault = () => address(VAULT ?? "");
  const owner = () => address(OWNER ?? "");

  it("validates the deployment and the vault, with the queue required", async () => {
    await expect(assertVedaVaultUsable(runtime(), config(), vault())).resolves.toBeUndefined();
  });

  it("builds a deposit whose programs the allowlist admits", async () => {
    const plan = await buildVedaDepositPlan(runtime(), config(), {
      vault: vault(),
      owner: owner(),
      amount: process.env.VEDA_SMOKE_AMOUNT ?? "1",
      // A deliberately tiny floor: this test proves the plan BUILDS, and a
      // realistic floor would make it fail for a reason that is not the code's.
      minSharesOut: process.env.VEDA_SMOKE_MIN_SHARES_OUT ?? "0.000001",
    });

    expect(plan.cluster).toBe("devnet");
    expect(planInstructionCount(plan)).toBeGreaterThan(0);
    expect(plan.accepted.amount).toBeDefined();
    expect(plan.accepted.minSharesOut).toBeDefined();
    // `assertPlanTargetsCluster` already ran inside the builder; this reports
    // WHAT it admitted, so a surprising program shows up in the failure output.
    expect(planProgramAddresses(plan).map(String).sort()).toMatchSnapshot();
  });

  it("reads a position without inventing a valuation", async () => {
    const position = await readVedaPosition(runtime(), config(), {
      vault: vault(),
      owner: owner(),
    });
    expect(position.cluster).toBe("devnet");
    expect(position.shares).toMatch(/^\d+(\.\d+)?$/);
    if (position.tokenValue !== undefined) {
      expect(position.tokenValue).toMatch(/^\d+(\.\d+)?$/);
    }
  });
});
