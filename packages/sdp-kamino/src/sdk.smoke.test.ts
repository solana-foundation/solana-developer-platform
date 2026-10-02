import { formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import type { SolanaCluster } from "@sdp/types";
import {
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createTransactionMessage,
  fetchAddressesForLookupTables,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { readKaminoDepositReceipt } from "./deposit-receipt";
import { planProgramAddresses } from "./guards";
import { kaminoClusterConfig } from "./programs";
import {
  buildKaminoDepositPlan,
  buildKaminoWithdrawPlan,
  quoteKaminoDeposit,
  readKaminoPosition,
} from "./sdk";
import type { KaminoInstructionPlan, KaminoRuntime } from "./types";

// Opt-in local fork only. Synthetic wallets are funded through Surfpool, never
// an existing keypair. Provider program and vault data are not patched by cheatcodes.
const RPC_URL = process.env.KAMINO_SMOKE_RPC_URL;
const CLUSTER = process.env.KAMINO_SMOKE_CLUSTER ?? "mainnet-beta";
const VAULT = address(
  process.env.KAMINO_SMOKE_VAULT ?? "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E"
);

async function cheat(method: string, params: unknown[]) {
  if (!RPC_URL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(RPC_URL).hostname)) {
    throw new Error("Kamino smoke tests require a loopback Surfpool RPC");
  }
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { error?: { message: string } };
  if (!response.ok || body.error) throw new Error(body.error?.message ?? response.statusText);
}

async function compile(
  rpc: ReturnType<typeof createSolanaRpc>,
  owner: TransactionSigner,
  plan: KaminoInstructionPlan
) {
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const lookupTables = await fetchAddressesForLookupTables([...plan.lookupTables], rpc);
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions([...plan.instructions], m),
    (m) => compressTransactionMessageUsingAddressLookupTables(m, lookupTables)
  );
}

async function execute(
  runtime: KaminoRuntime,
  owner: TransactionSigner,
  plan: KaminoInstructionPlan,
  signers: TransactionSigner[] = []
) {
  const rpc = createSolanaRpc(runtime.rpcUrl);
  expect(planProgramAddresses(plan)).toContain(
    kaminoClusterConfig(runtime.cluster).kvaultProgramId
  );
  const signed = await signTransactionMessageWithSigners(
    addSignersToTransactionMessage(signers, await compile(rpc, owner, plan))
  );
  expect(getTransactionEncoder().encode(signed).length).toBeLessThanOrEqual(1232);
  const wire = getBase64EncodedWireTransaction(signed);
  const sim = await rpc.simulateTransaction(wire, { encoding: "base64" }).send();
  expect(sim.value.err, JSON.stringify(sim.value.logs)).toBeNull();
  const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const { value } = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .send();
    const status = value[0];
    if (status) {
      expect(status.err).toBeNull();
      if (status.confirmationStatus === "finalized") return signature;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local fork did not confirm the transaction");
}

describe.skipIf(!RPC_URL)("Kamino plans against a local fork", () => {
  it("enforces the deposit floor, lands a deposit, and redeems partial and full positions", async () => {
    if (CLUSTER !== "mainnet-beta" && CLUSTER !== "devnet") throw new Error("Unsupported cluster");
    const runtime = { cluster: CLUSTER as SolanaCluster, rpcUrl: RPC_URL ?? "" };
    const rpc = createSolanaRpc(runtime.rpcUrl);
    const owner = await generateKeyPairSigner();
    await cheat("surfnet_setAccount", [owner.address, { lamports: 1_000_000_000 }]);
    // Lazily cloned accounts can be ahead of the fork's initial slot.
    const startSlot = await rpc.getSlot().send();
    await cheat("surfnet_timeTravel", [{ absoluteSlot: Number(startSlot) + 10_000 }]);

    const position = () =>
      rpc
        .getSlot()
        .send()
        .then((slot) => readKaminoPosition(runtime, { vault: VAULT, owner: owner.address, slot }));
    const initial = await position();
    expect(initial.shares).toBe("0");
    const mintAccount = await rpc.getAccountInfo(initial.tokenMint, { encoding: "base64" }).send();
    if (!mintAccount.value) throw new Error("Deposit mint is missing from the fork");
    await cheat("surfnet_setTokenAccount", [
      owner.address,
      initial.tokenMint,
      { amount: 100_000_000 },
      mintAccount.value.owner,
    ]);

    const quote = await quoteKaminoDeposit(runtime, {
      vault: VAULT,
      amount: "25",
      slot: await rpc.getSlot().send(),
    });
    expect(quote.issues).toEqual([]);
    const quotedShares = parseDecimalAmount(quote.sharesOut, quote.shareDecimals);
    const supportsFloor = kaminoClusterConfig(runtime.cluster).depositFloorSupported;
    if (supportsFloor) {
      const impossible = await buildKaminoDepositPlan(runtime, {
        vault: VAULT,
        owner,
        amount: "25",
        minSharesOut: formatDecimalAmount(quotedShares * 2n, quote.shareDecimals),
      });
      const unsigned = compileTransaction(await compile(rpc, owner, impossible));
      const simulation = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(unsigned), {
          encoding: "base64",
          sigVerify: false,
        })
        .send();
      expect(simulation.value.err).not.toBeNull();
      expect(simulation.value.logs?.join("\n")).toContain("SharesOutBelowMinimum");
      expect((await position()).shares).toBe("0");
    }

    const depositSignature = await execute(
      runtime,
      owner,
      await buildKaminoDepositPlan(runtime, {
        vault: VAULT,
        owner,
        amount: "25",
        ...(supportsFloor
          ? {
              minSharesOut: formatDecimalAmount((quotedShares * 999n) / 1000n, quote.shareDecimals),
            }
          : {}),
      })
    );
    const deposited = await position();
    const receipt = await readKaminoDepositReceipt(runtime, {
      signature: depositSignature,
      vault: VAULT,
      owner: owner.address,
      tokenMint: initial.tokenMint,
      shareMint: initial.sharesMint,
      requestedAmount: "25",
    });
    expect(receipt).toEqual({ amount: "25", sharesOut: deposited.shares });
    const depositedShares = parseDecimalAmount(deposited.shares, quote.shareDecimals);
    expect(depositedShares).toBeGreaterThan(0n);
    expect(deposited.withdrawableShares).toBe(deposited.shares);

    const partial = depositedShares / 3n;
    await execute(
      runtime,
      owner,
      await buildKaminoWithdrawPlan(runtime, {
        vault: VAULT,
        owner,
        shares: formatDecimalAmount(partial, quote.shareDecimals),
        slot: await rpc.getSlot().send(),
      })
    );
    const remaining = await position();
    expect(parseDecimalAmount(remaining.shares, quote.shareDecimals)).toBe(
      depositedShares - partial
    );
    await execute(
      runtime,
      owner,
      await buildKaminoWithdrawPlan(runtime, {
        vault: VAULT,
        owner,
        shares: remaining.shares,
        slot: await rpc.getSlot().send(),
      })
    );
    expect((await position()).shares).toBe("0");
    const [shareAta] = await findAssociatedTokenPda({
      owner: owner.address,
      mint: initial.sharesMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    // Its creation predates the exit, so no payer is guessed for a rent refund.
    expect(
      (await rpc.getAccountInfo(shareAta, { encoding: "base64" }).send()).value
    ).not.toBeNull();
    const balances = await rpc
      .getTokenAccountsByOwner(
        owner.address,
        { mint: initial.tokenMint },
        { encoding: "jsonParsed" }
      )
      .send();
    const returned = balances.value.reduce(
      (sum, entry) => sum + BigInt(entry.account.data.parsed.info.tokenAmount.amount),
      0n
    );
    expect(returned).toBeGreaterThan(99_000_000n);
  }, 180_000);
  it("does not refund a concurrent creation claimant who paid no rent", async () => {
    if (CLUSTER !== "mainnet-beta" && CLUSTER !== "devnet") throw new Error("Unsupported cluster");
    const runtime = { cluster: CLUSTER as SolanaCluster, rpcUrl: RPC_URL ?? "" };
    const rpc = createSolanaRpc(runtime.rpcUrl);
    const owner = await generateKeyPairSigner();
    const firstPayer = await generateKeyPairSigner();
    const secondPayer = await generateKeyPairSigner();
    for (const signer of [owner, firstPayer, secondPayer]) {
      await cheat("surfnet_setAccount", [signer.address, { lamports: 1_000_000_000 }]);
    }
    const initial = await readKaminoPosition(runtime, {
      vault: VAULT,
      owner: owner.address,
      slot: await rpc.getSlot().send(),
    });
    const mint = await rpc.getAccountInfo(initial.tokenMint, { encoding: "base64" }).send();
    if (!mint.value) throw new Error("Deposit mint missing");
    await cheat("surfnet_setTokenAccount", [
      owner.address,
      initial.tokenMint,
      { amount: 100_000_000 },
      mint.value.owner,
    ]);
    const plans = await Promise.all(
      [firstPayer, secondPayer].map((rentPayer) =>
        buildKaminoDepositPlan(runtime, { vault: VAULT, owner, rentPayer, amount: "1" })
      )
    );
    expect(plans.map((plan) => plan.createsShareAccount)).toEqual([true, true]);
    const firstBefore = (await rpc.getBalance(firstPayer.address).send()).value;
    const secondBefore = (await rpc.getBalance(secondPayer.address).send()).value;
    await execute(runtime, owner, plans[0], [firstPayer]);
    await execute(runtime, owner, plans[1], [secondPayer]);
    const rentPaid = firstBefore - (await rpc.getBalance(firstPayer.address).send()).value;
    expect(rentPaid).toBeGreaterThan(0n);
    expect((await rpc.getBalance(secondPayer.address).send()).value).toBe(secondBefore);
    const holding = await readKaminoPosition(runtime, {
      vault: VAULT,
      owner: owner.address,
      slot: await rpc.getSlot().send(),
    });
    await execute(
      runtime,
      owner,
      await buildKaminoWithdrawPlan(runtime, {
        vault: VAULT,
        owner,
        shares: holding.shares,
        rentRefundTo: secondPayer.address,
        slot: await rpc.getSlot().send(),
      })
    );
    expect((await rpc.getBalance(secondPayer.address).send()).value).toBe(secondBefore);
    const [shareAta] = await findAssociatedTokenPda({
      owner: owner.address,
      mint: initial.sharesMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const retained = (await rpc.getAccountInfo(shareAta, { encoding: "jsonParsed" }).send()).value;
    expect(retained?.lamports).toBe(rentPaid);
    expect(
      (
        await readKaminoPosition(runtime, {
          vault: VAULT,
          owner: owner.address,
          slot: await rpc.getSlot().send(),
        })
      ).shares
    ).toBe("0");
  }, 180_000);
});
