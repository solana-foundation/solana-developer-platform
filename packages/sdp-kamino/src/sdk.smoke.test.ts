import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { planProgramAddresses } from "./guards";
import { kaminoClusterConfig } from "./programs";
import { buildKaminoDepositPlan, buildKaminoWithdrawPlan, readKaminoPosition } from "./sdk";

/**
 * On-chain smoke test. **Opt-in, and never runs in CI** — the package's other
 * tests are pure and offline, per the repo rule that package tests touch no
 * network.
 *
 * Run it against a surfpool surfnet forking mainnet, which gives a real kvault
 * program and a real vault with no mainnet money at risk:
 *
 *   KAMINO_SMOKE_RPC_URL=http://127.0.0.1:8899 \
 *   KAMINO_SMOKE_SIGNER=<64 hex chars: 32 private key bytes> \
 *   pnpm --filter @sdp/kamino test
 *
 * Fund the signer first with SOL and the vault's deposit token
 * (`surfnet_setTokenAccount`). What this proves that the offline tests cannot:
 * the instructions the package emits actually SIMULATE and LAND, and the
 * position read reports what the chain holds.
 */
const RPC_URL = process.env.KAMINO_SMOKE_RPC_URL;
const SIGNER_HEX = process.env.KAMINO_SMOKE_SIGNER;
// Mainnet USDC K-Vault — the vault Kamino's own deposit doc uses.
const VAULT = address(
  process.env.KAMINO_SMOKE_VAULT ?? "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E"
);

describe.skipIf(!RPC_URL || !SIGNER_HEX)("Kamino plans against a live chain", () => {
  const runtime = { cluster: "mainnet-beta" as const, rpcUrl: RPC_URL ?? "" };

  async function signer() {
    const bytes = Uint8Array.from(
      (SIGNER_HEX ?? "").match(/.{1,2}/g)?.map((b) => Number.parseInt(b, 16)) ?? []
    );
    return await createKeyPairSignerFromPrivateKeyBytes(bytes);
  }

  it("builds a deposit that simulates cleanly and lands", async () => {
    const rpc = createSolanaRpc(runtime.rpcUrl);
    const owner = await signer();

    const plan = await buildKaminoDepositPlan(runtime, {
      vault: VAULT,
      owner,
      amount: "25",
    });

    // The guard already ran inside the builder; assert the property directly too.
    const programs = planProgramAddresses(plan);
    expect(programs).toContain(kaminoClusterConfig("mainnet-beta").kvaultProgramId);
    expect(programs).not.toContain(kaminoClusterConfig("devnet").kvaultProgramId);

    const batch = plan.instructions[0];
    expect(batch, "deposit plan must carry one transaction's worth").toBeDefined();

    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(owner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions([...(batch ?? [])], m)
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);

    const sim = await rpc
      .simulateTransaction(wire, { encoding: "base64", replaceRecentBlockhash: true })
      .send();
    expect(sim.value.err, `simulation failed: ${JSON.stringify(sim.value.logs)}`).toBeNull();

    const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
    expect(signature).toBeTruthy();
  });

  it("reads back the position it just created", async () => {
    const rpc = createSolanaRpc(runtime.rpcUrl);
    const owner = await signer();
    const slot = await rpc.getSlot().send();

    const position = await readKaminoPosition(runtime, {
      vault: VAULT,
      owner: owner.address,
      slot,
    });

    expect(position.cluster).toBe("mainnet-beta");
    expect(Number(position.shares)).toBeGreaterThan(0);
    // Value may legitimately be absent if the rate read failed; when present it
    // must be a plain decimal string, never a float artefact.
    if (position.tokenValue !== undefined) {
      expect(position.tokenValue).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it("builds a withdrawal for the full position", async () => {
    const rpc = createSolanaRpc(runtime.rpcUrl);
    const owner = await signer();
    const slot = await rpc.getSlot().send();
    const position = await readKaminoPosition(runtime, {
      vault: VAULT,
      owner: owner.address,
      slot,
    });

    const plan = await buildKaminoWithdrawPlan(runtime, {
      vault: VAULT,
      owner,
      shares: position.shares,
      slot,
    });

    expect(planProgramAddresses(plan)).toContain(
      kaminoClusterConfig("mainnet-beta").kvaultProgramId
    );
    expect(plan.instructions[0]?.length ?? 0).toBeGreaterThan(0);
  });
});
