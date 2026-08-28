import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types";
import {
  WISDOMTREE_FUNDS,
  WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS,
} from "@sdp/types/wisdomtree-programs";
import { address, createNoopSigner } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { SdpWisdomTreeError } from "./errors";
import { fakeReader, tokenAccountData, wtgxxMintAccountData } from "./fixtures.test-helper";
import { parseFundMint } from "./mint";
import { buildWisdomTreeDepositPlan, verifyFundMint } from "./plan";
import type { WisdomTreeRuntime } from "./types";

const WTGXX = WISDOMTREE_FUNDS[0];
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;
const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];
const SPL_TOKEN = SPL_TOKEN_PROGRAMS["spl-token"];

// Any valid 32-byte pubkeys serve as wallets in an offline build.
const OWNER = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ON_RECEIPT = "ComputeBudget111111111111111111111111111111";

const runtime: WisdomTreeRuntime = { cluster: "mainnet-beta", rpcUrl: "http://offline.invalid" };

async function ata(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const [derived] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: address(tokenProgram),
  });
  return String(derived);
}

function depositInput(overrides: Partial<Parameters<typeof buildWisdomTreeDepositPlan>[2]> = {}) {
  return {
    fund: WTGXX,
    owner: createNoopSigner(address(OWNER)),
    onReceiptWallet: address(ON_RECEIPT),
    depositMint: address(USDC),
    depositDecimals: 6,
    amount: "25.5",
    ...overrides,
  };
}

describe("parseFundMint against the live WTGXX bytes", () => {
  it("reads the decimals and the transfer-hook program the chain states", () => {
    const parsed = parseFundMint(wtgxxMintAccountData());
    expect(parsed.decimals).toBe(9);
    expect(parsed.transferHookProgram).toBe(WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"]);
  });
});

describe("verifyFundMint", () => {
  it("accepts the live mainnet mint image", async () => {
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
    });
    await expect(verifyFundMint(reader, runtime, WTGXX)).resolves.toBeUndefined();
  });

  it.each([
    ["a missing mint", {}],
    [
      "a mint owned by the classic token program",
      { [WTGXX.mint]: { owner: SPL_TOKEN, data: wtgxxMintAccountData() } },
    ],
  ])("refuses %s", async (_label, accounts) => {
    const reader = fakeReader(accounts as Parameters<typeof fakeReader>[0]);
    await expect(verifyFundMint(reader, runtime, WTGXX)).rejects.toThrowError(SdpWisdomTreeError);
  });

  it("refuses a mint whose hook program drifted from the registry", async () => {
    const drifted = wtgxxMintAccountData();
    // Flip one byte inside the TransferHook extension's program field (the
    // extension body starts at 371: authority 371..403, program 403..435).
    drifted[403] = drifted[403] === 0 ? 1 : 0;
    const parsedHook = parseFundMint(drifted).transferHookProgram;
    // Fixture sanity: the flip landed inside the hook program bytes.
    expect(parsedHook).not.toBe(WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"]);

    const reader = fakeReader({ [WTGXX.mint]: { owner: TOKEN_2022, data: drifted } });
    await expect(verifyFundMint(reader, runtime, WTGXX)).rejects.toThrowError(/transfer hook/);
  });
});

describe("buildWisdomTreeDepositPlan", () => {
  it("builds create-share-ATA + transfer for a first-time owner", async () => {
    const onReceiptUsdcAta = await ata(ON_RECEIPT, USDC, SPL_TOKEN);
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      // On-receipt wallet already holds a USDC ATA; the owner holds no fund ATA.
      [onReceiptUsdcAta]: { data: tokenAccountData(0n) },
    });

    const plan = await buildWisdomTreeDepositPlan(reader, runtime, depositInput());

    expect(plan.cluster).toBe("mainnet-beta");
    expect(plan.createsShareAccount).toBe(true);
    expect(plan.accepted).toEqual({ amount: "25.5" });
    expect(plan.assetIdentity).toEqual({
      depositTokenMint: address(USDC),
      shareMint: address(WTGXX.mint),
    });

    // ATA program creates the owner's fund-token account, then the classic
    // token program moves the USDC. No hook program: USDC carries no hook.
    expect(plan.instructions.map((instruction) => String(instruction.programAddress))).toEqual([
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      SPL_TOKEN,
    ]);

    const transfer = plan.instructions.at(-1);
    const ownerUsdcAta = await ata(OWNER, USDC, SPL_TOKEN);
    expect(transfer?.accounts?.map((account) => String(account.address))).toEqual([
      ownerUsdcAta,
      USDC,
      onReceiptUsdcAta,
      OWNER,
    ]);
  });

  it("creates the on-receipt USDC ATA only when it is measured absent", async () => {
    const ownerFundAta = await ata(OWNER, WTGXX.mint, TOKEN_2022);
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      // Owner already holds the fund ATA; the on-receipt USDC ATA does not exist.
      [ownerFundAta]: { owner: TOKEN_2022, data: tokenAccountData(1n) },
    });

    const plan = await buildWisdomTreeDepositPlan(reader, runtime, depositInput());
    expect(plan.createsShareAccount).toBe(false);
    expect(plan.instructions).toHaveLength(2);
    const create = plan.instructions[0];
    expect(String(create.programAddress)).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    // The created account is WisdomTree's USDC ATA, funded by the rent payer
    // (defaulting to the owner).
    const onReceiptUsdcAta = await ata(ON_RECEIPT, USDC, SPL_TOKEN);
    expect(create.accounts?.some((account) => String(account.address) === onReceiptUsdcAta)).toBe(
      true
    );
  });

  it("routes rent to an explicit rentPayer", async () => {
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
    });
    const sponsor = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
    const plan = await buildWisdomTreeDepositPlan(
      reader,
      runtime,
      depositInput({ rentPayer: createNoopSigner(address(sponsor)) })
    );
    const create = plan.instructions[0];
    expect(String(create.accounts?.[0]?.address)).toBe(sponsor);
  });

  it("refuses a sub-atomic amount before any instruction is built", async () => {
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
    });
    await expect(
      buildWisdomTreeDepositPlan(reader, runtime, depositInput({ amount: "1.0000001" }))
    ).rejects.toThrowError(/finer than the mint's 6 decimals/);
  });
});
