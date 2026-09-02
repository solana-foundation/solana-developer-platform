import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types";
import {
  WISDOMTREE_FUNDS,
  WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS,
} from "@sdp/types/wisdomtree-programs";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  AccountState,
  extension,
  findAssociatedTokenPda,
  getTokenEncoder,
} from "@solana-program/token-2022";
import { beforeAll, describe, expect, it } from "vitest";
import { createWisdomTreeChainReader, tokenAccountBaseUnits } from "./chain";
import { SdpWisdomTreeError } from "./errors";
import { buildWisdomTreeDepositPlan, buildWisdomTreeRedemptionPlan } from "./plan";
import { encodeWisdomTreeFundTokenAccount } from "./token-account";

/**
 * On-chain smoke test against a surfpool surfnet FORKING MAINNET. **Opt-in,
 * never in CI** — every other test in this package is offline.
 *
 *   surfpool start --no-tui   # forks mainnet-beta on :8899
 *   WISDOMTREE_SMOKE_RPC_URL=http://127.0.0.1:8899 \
 *   WISDOMTREE_SMOKE_SIGNER=<64 hex chars: 32 private key bytes> \
 *   pnpm --filter @sdp/wisdomtree test
 *
 * What it proves that the offline tests cannot, against the REAL WTGXX mint,
 * hook program, and ExtraAccountMetaList:
 *
 * 1. The subscription leg (USDC to the on-receipt wallet, plus the owner's
 *    fund-token ATA creation) SIMULATES CLEANLY for any funded wallet — the
 *    deposit's on-chain half carries no compliance gate of its own.
 * 2. The redemption leg FAILS AT THE KYC STAGE for a wallet WisdomTree never
 *    verified: either this package's hook resolver refuses (HOOK_UNRESOLVED —
 *    a required compliance account does not exist for the unverified wallet),
 *    or the fully-resolved transfer simulates and the hook program itself
 *    rejects it. Both outcomes are the compliance model working, and the test
 *    accepts exactly those two and nothing else.
 *
 * 3. A complete local lifecycle LANDS after Surfpool installs the exact
 *    non-transferable credential ATAs the real hook resolves. The transfer
 *    agent's delayed fund-token and USDC settlements are also explicit
 *    cheatcode state transitions. This proves SDP's on-chain integration, not
 *    WisdomTree's off-chain Connect API or transfer-agent implementation.
 *
 * The Connect API is deliberately NOT exercised (SDP holds no credentials);
 * the on-receipt wallets are stub addresses, which changes nothing about what
 * the production hook enforces.
 */
const RPC_URL = process.env.WISDOMTREE_SMOKE_RPC_URL;
const SIGNER_HEX = process.env.WISDOMTREE_SMOKE_SIGNER;

const WTGXX = WISDOMTREE_FUNDS[0];
const HOOK_PROGRAM = WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"] as string;
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;

describe.skipIf(!RPC_URL || !SIGNER_HEX)("WisdomTree plans against a mainnet fork", () => {
  const runtime = { cluster: "mainnet-beta" as const, rpcUrl: RPC_URL ?? "" };

  async function signer() {
    const bytes = Uint8Array.from(
      (SIGNER_HEX ?? "").match(/.{1,2}/g)?.map((b) => Number.parseInt(b, 16)) ?? []
    );
    return await createKeyPairSignerFromPrivateKeyBytes(bytes);
  }

  async function cheat(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(RPC_URL ?? "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new Error(`${method} failed: ${body.error.message}`);
    }
    return body.result;
  }

  const hex = (data: Uint8Array): string =>
    [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  const token2022 = address(SPL_TOKEN_PROGRAMS["token-2022"]);

  function encodeComplianceCredential(
    mint: ReturnType<typeof address>,
    owner: ReturnType<typeof address>
  ) {
    return Uint8Array.from(
      getTokenEncoder().encode({
        mint,
        owner,
        amount: 1n,
        delegate: null,
        state: AccountState.Initialized,
        isNative: null,
        delegatedAmount: 0n,
        closeAuthority: null,
        extensions: [extension("ImmutableOwner", {}), extension("NonTransferableAccount", {})],
      })
    );
  }

  async function setRawTokenAccount(
    accountAddress: string,
    data: Uint8Array,
    lamports = 10_000_000
  ) {
    await cheat("surfnet_setAccount", [
      accountAddress,
      {
        lamports,
        owner: String(token2022),
        data: hex(data),
        executable: false,
        rentEpoch: 0,
      },
    ]);
  }

  async function simulate(
    // The SAME signer instance the plan was built with — kit refuses two
    // distinct signer objects for one address.
    owner: Awaited<ReturnType<typeof signer>>,
    instructions: Parameters<typeof appendTransactionMessageInstructions>[0]
  ) {
    const rpc = createSolanaRpc(runtime.rpcUrl);
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(owner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m)
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);
    return await rpc
      .simulateTransaction(wire, { encoding: "base64", replaceRecentBlockhash: true })
      .send();
  }

  async function land(
    owner: Awaited<ReturnType<typeof signer>>,
    instructions: Parameters<typeof appendTransactionMessageInstructions>[0]
  ) {
    const rpc = createSolanaRpc(runtime.rpcUrl);
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(owner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m)
    );
    const signed = await signTransactionMessageWithSigners(message);
    const wire = getBase64EncodedWireTransaction(signed);
    const response = await fetch(runtime.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [wire, { encoding: "base64" }],
      }),
    });
    const body = (await response.json()) as {
      result?: string;
      error?: { code?: number; message?: string; data?: unknown };
    };
    if (body.error || !body.result) {
      throw new Error(`sendTransaction failed: ${JSON.stringify(body.error ?? body)}`);
    }
    return body.result;
  }

  async function balance(accountAddress: ReturnType<typeof address>): Promise<bigint> {
    const account = await createWisdomTreeChainReader(runtime.rpcUrl).getAccount(accountAddress);
    expect(account, `expected token account ${accountAddress} to exist`).not.toBeNull();
    return tokenAccountBaseUnits(account?.data ?? new Uint8Array());
  }

  beforeAll(async () => {
    const owner = await signer();
    await cheat("surfnet_setAccount", [
      String(owner.address),
      {
        lamports: 10_000_000_000,
        owner: "11111111111111111111111111111111",
        data: "",
        executable: false,
        rentEpoch: 0,
      },
    ]);
    await cheat("surfnet_setTokenAccount", [
      String(owner.address),
      USDC,
      { amount: 1_000_000_000 },
    ]);
    // Fund tokens for the redemption leg — a balance the owner could only have
    // via cheatcode, since the real mint only settles to verified wallets.
    const [ownerFundAta] = await findAssociatedTokenPda({
      owner: owner.address,
      mint: address(WTGXX.mint),
      tokenProgram: address(SPL_TOKEN_PROGRAMS["token-2022"]),
    });
    await setRawTokenAccount(
      String(ownerFundAta),
      encodeWisdomTreeFundTokenAccount(address(WTGXX.mint), owner.address, 5_000_000_000n)
    );
  });

  it("subscription: builds against the live mint and simulates cleanly", async () => {
    const owner = await signer();
    const onReceiptStub = await generateKeyPairSigner();
    const reader = createWisdomTreeChainReader(runtime.rpcUrl);

    const plan = await buildWisdomTreeDepositPlan(reader, runtime, {
      fund: WTGXX,
      owner,
      onReceiptWallet: onReceiptStub.address,
      depositMint: address(USDC),
      depositDecimals: 6,
      amount: "250",
    });

    expect(plan.accepted).toEqual({ amount: "250" });
    const sim = await simulate(owner, [...plan.instructions]);
    expect(
      sim.value.err,
      `subscription simulation failed: ${JSON.stringify(sim.value.logs)}`
    ).toBeNull();
  });

  it("redemption: fails at the KYC stage for an unverified wallet", async () => {
    const owner = await signer();
    const onReceiptStub = await generateKeyPairSigner();
    const reader = createWisdomTreeChainReader(runtime.rpcUrl);

    let plan: Awaited<ReturnType<typeof buildWisdomTreeRedemptionPlan>>;
    try {
      plan = await buildWisdomTreeRedemptionPlan(reader, runtime, {
        fund: WTGXX,
        owner,
        onReceiptWallet: onReceiptStub.address,
        depositMint: address(USDC),
        shares: "1",
      });
    } catch (error) {
      // KYC refusal, form 1: the hook's account recipes need compliance state
      // that does not exist for this wallet, so resolution fails closed.
      expect(error).toBeInstanceOf(SdpWisdomTreeError);
      expect((error as SdpWisdomTreeError).code).toBe("HOOK_UNRESOLVED");
      expect((error as SdpWisdomTreeError).message).toMatch(/compliance account|not been verified/);
      return;
    }

    // KYC refusal, form 2: the accounts resolved, so the transfer reaches the
    // hook program on-chain and the hook itself must reject the transfer.
    const sim = await simulate(owner, [...plan.instructions]);
    expect(
      sim.value.err,
      "an unverified wallet's redemption must NOT simulate cleanly"
    ).not.toBeNull();
    const logs = (sim.value.logs ?? []).join("\n");
    expect(logs, `expected the WisdomTree compliance hook in the failure logs:\n${logs}`).toContain(
      `Program ${HOOK_PROGRAM} invoke`
    );
    expect(logs, `expected the unverified-wallet SBT refusal:\n${logs}`).toContain(
      "Error Code: EmptySbtAccount. Error Number: 13013. " +
        "Error Message: Empty SBT account: account has no data."
    );
  });

  it("deposit + redemption: lands locally with KYC and settlement emulated", async () => {
    const owner = await signer();
    const purchaseWallet = await generateKeyPairSigner();
    const saleWallet = await generateKeyPairSigner();
    const reader = createWisdomTreeChainReader(runtime.rpcUrl);
    const fundMint = address(WTGXX.mint);
    const usdcMint = address(USDC);

    const [ownerUsdcAta] = await findAssociatedTokenPda({
      owner: owner.address,
      mint: usdcMint,
      tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]),
    });
    const [purchaseUsdcAta] = await findAssociatedTokenPda({
      owner: purchaseWallet.address,
      mint: usdcMint,
      tokenProgram: address(SPL_TOKEN_PROGRAMS["spl-token"]),
    });
    const [ownerFundAta] = await findAssociatedTokenPda({
      owner: owner.address,
      mint: fundMint,
      tokenProgram: token2022,
    });
    const [saleFundAta] = await findAssociatedTokenPda({
      owner: saleWallet.address,
      mint: fundMint,
      tokenProgram: token2022,
    });

    // Isolate this lifecycle from the negative-control test above.
    await cheat("surfnet_setTokenAccount", [
      String(owner.address),
      USDC,
      { amount: 1_000_000_000 },
    ]);
    await setRawTokenAccount(
      String(ownerFundAta),
      encodeWisdomTreeFundTokenAccount(fundMint, owner.address)
    );

    // Build the later redemption first: the live ExtraAccountMetaList reveals
    // the exact two credential ATAs the production hook will inspect. Its
    // compliance config carries the SBT mint at byte 40, which is also the
    // live PDA seed recipe.
    const redemption = await buildWisdomTreeRedemptionPlan(reader, runtime, {
      fund: WTGXX,
      owner,
      onReceiptWallet: saleWallet.address,
      depositMint: usdcMint,
      shares: "250",
    });
    const transferAccounts = redemption.instructions.at(-1)?.accounts ?? [];
    expect(transferAccounts).toHaveLength(11);
    const complianceConfigAddress = transferAccounts[4]?.address;
    if (!complianceConfigAddress) throw new Error("hook plan omitted its compliance config");
    const complianceConfig = await reader.getAccount(complianceConfigAddress);
    expect(complianceConfig?.data.length).toBeGreaterThanOrEqual(72);
    if (!complianceConfig || complianceConfig.data.length < 72) {
      throw new Error("hook compliance config omitted its credential mint");
    }
    const credentialMint = getAddressDecoder().decode(complianceConfig.data.subarray(40, 72));
    // Clone the real credential mint into Surfpool before installing token
    // accounts for it; the surfnet's transaction verifier rejects otherwise
    // valid local token accounts whose mint has not been loaded yet.
    const credentialMintAccount = await reader.getAccount(credentialMint);
    expect(credentialMintAccount?.owner).toBe(String(token2022));
    const [ownerCredentialAta] = await findAssociatedTokenPda({
      owner: owner.address,
      mint: credentialMint,
      tokenProgram: token2022,
    });
    const [saleCredentialAta] = await findAssociatedTokenPda({
      owner: saleWallet.address,
      mint: credentialMint,
      tokenProgram: token2022,
    });
    expect(String(transferAccounts[7]?.address)).toBe(String(ownerCredentialAta));
    expect(String(transferAccounts[8]?.address)).toBe(String(saleCredentialAta));

    // Local-only KYC: create one non-transferable credential token at each ATA.
    // The real hook remains untouched and must accept these exact account bytes.
    await setRawTokenAccount(
      String(ownerCredentialAta),
      encodeComplianceCredential(credentialMint, owner.address)
    );
    await setRawTokenAccount(
      String(saleCredentialAta),
      encodeComplianceCredential(credentialMint, saleWallet.address)
    );

    const deposit = await buildWisdomTreeDepositPlan(reader, runtime, {
      fund: WTGXX,
      owner,
      onReceiptWallet: purchaseWallet.address,
      depositMint: usdcMint,
      depositDecimals: 6,
      amount: "250",
    });
    const depositSim = await simulate(owner, [...deposit.instructions]);
    expect(
      depositSim.value.err,
      `deposit simulation failed: ${JSON.stringify(depositSim.value.logs)}`
    ).toBeNull();
    expect(await land(owner, [...deposit.instructions])).toBeTruthy();
    expect(await balance(ownerUsdcAta)).toBe(750_000_000n);
    expect(await balance(purchaseUsdcAta)).toBe(250_000_000n);

    // WisdomTree strikes NAV and transfers fund tokens later, outside the
    // deposit transaction. Model that external settlement as an explicit fork
    // state transition so the next leg starts from a settled position.
    const settledShares = 250_000_000_000n;
    await setRawTokenAccount(
      String(ownerFundAta),
      encodeWisdomTreeFundTokenAccount(fundMint, owner.address, settledShares)
    );

    const redemptionSim = await simulate(owner, [...redemption.instructions]);
    expect(
      redemptionSim.value.err,
      `redemption simulation failed: ${JSON.stringify(redemptionSim.value.logs)}`
    ).toBeNull();
    expect(await land(owner, [...redemption.instructions])).toBeTruthy();
    expect(await balance(ownerFundAta)).toBe(0n);
    expect(await balance(saleFundAta)).toBe(settledShares);

    // Redemption USDC also settles asynchronously through the transfer agent.
    // Restore the owner's original USDC balance to represent that final leg.
    await cheat("surfnet_setTokenAccount", [
      String(owner.address),
      USDC,
      { amount: 1_000_000_000 },
    ]);
    expect(await balance(ownerUsdcAta)).toBe(1_000_000_000n);
  });
});
