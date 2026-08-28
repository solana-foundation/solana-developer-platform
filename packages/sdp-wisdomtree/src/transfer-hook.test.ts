import { createHash } from "node:crypto";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types";
import {
  WISDOMTREE_FUNDS,
  WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS,
} from "@sdp/types/wisdomtree-programs";
import {
  address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { SdpWisdomTreeError } from "./errors";
import { fakeReader, tokenAccountData, wtgxxMintAccountData } from "./fixtures.test-helper";
import { buildWisdomTreeRedemptionPlan } from "./plan";
import {
  deriveExtraAccountMetasAddress,
  resolveTransferHookAccounts,
  TRANSFER_HOOK_EXECUTE_DISCRIMINATOR,
} from "./transfer-hook";
import type { WisdomTreeRuntime } from "./types";

const WTGXX = WISDOMTREE_FUNDS[0];
const HOOK = WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS["mainnet-beta"] as string;
const USDC = wellKnownMint("USDC", "mainnet-beta") as string;
const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];

const OWNER = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ON_RECEIPT = "ComputeBudget111111111111111111111111111111";

const runtime: WisdomTreeRuntime = { cluster: "mainnet-beta", rpcUrl: "http://offline.invalid" };
const encoder = getAddressEncoder();

/** Serialize an ExtraAccountMetaList account image: TLV header + count + entries. */
function metaListAccount(entries: Uint8Array[]): Uint8Array {
  const body = new Uint8Array(4 + entries.length * 35);
  new DataView(body.buffer).setUint32(0, entries.length, true);
  entries.forEach((entry, index) => {
    body.set(entry, 4 + index * 35);
  });
  const data = new Uint8Array(12 + body.length);
  data.set(TRANSFER_HOOK_EXECUTE_DISCRIMINATOR, 0);
  new DataView(data.buffer).setUint32(8, body.length, true);
  data.set(body, 12);
  return data;
}

function literalEntry(pubkey: string, flags: { isSigner?: boolean; isWritable?: boolean } = {}) {
  const entry = new Uint8Array(35);
  entry[0] = 0;
  entry.set(encoder.encode(address(pubkey)), 1);
  entry[33] = flags.isSigner ? 1 : 0;
  entry[34] = flags.isWritable ? 1 : 0;
  return entry;
}

/** PDA on the hook program from a literal seed plus the mint's account key (execute index 1). */
function pdaEntry(literalSeed: string) {
  const entry = new Uint8Array(35);
  entry[0] = 1;
  const seedBytes = new TextEncoder().encode(literalSeed);
  let offset = 1;
  entry[offset] = 1; // literal seed tag
  entry[offset + 1] = seedBytes.length;
  entry.set(seedBytes, offset + 2);
  offset += 2 + seedBytes.length;
  entry[offset] = 3; // account-key seed tag
  entry[offset + 1] = 1; // execute index 1 = the mint
  entry[34] = 0;
  return entry;
}

/** PDA on the hook program seeded from the destination token account's owner field. */
function destinationOwnerPdaEntry() {
  const entry = new Uint8Array(35);
  entry[0] = 1;
  entry[1] = 4; // account-data seed tag
  entry[2] = 2; // execute index 2 = destination token account
  entry[3] = 32; // token-account owner field offset
  entry[4] = 32;
  return entry;
}

describe("discriminator derivation", () => {
  it("pins the execute discriminator to its sha256 derivation", () => {
    const derived = createHash("sha256")
      .update("spl-transfer-hook-interface:execute")
      .digest()
      .subarray(0, 8);
    expect([...TRANSFER_HOOK_EXECUTE_DISCRIMINATOR]).toEqual([...derived]);
  });
});

describe("resolveTransferHookAccounts", () => {
  async function fixtures(entries: Uint8Array[]) {
    const validation = await deriveExtraAccountMetasAddress(address(HOOK), address(WTGXX.mint));
    const [source] = await findAssociatedTokenPda({
      owner: address(OWNER),
      mint: address(WTGXX.mint),
      tokenProgram: address(TOKEN_2022),
    });
    const [destination] = await findAssociatedTokenPda({
      owner: address(ON_RECEIPT),
      mint: address(WTGXX.mint),
      tokenProgram: address(TOKEN_2022),
    });
    const reader = fakeReader({
      [String(validation)]: { owner: HOOK, data: metaListAccount(entries) },
    });
    return { validation, source, destination, reader };
  }

  it("resolves literal and PDA-recipe entries and appends program + validation last", async () => {
    const { validation, source, destination, reader } = await fixtures([
      literalEntry(USDC),
      pdaEntry("wt-compliance"),
    ]);

    const accounts = await resolveTransferHookAccounts(reader, {
      hookProgram: address(HOOK),
      mint: address(WTGXX.mint),
      source,
      destination,
      owner: address(OWNER),
      amount: 1_000_000_000n,
    });

    const [expectedPda] = await getProgramDerivedAddress({
      programAddress: address(HOOK),
      seeds: ["wt-compliance", encoder.encode(address(WTGXX.mint))],
    });
    expect(accounts.map((account) => String(account.address))).toEqual([
      USDC,
      String(expectedPda),
      HOOK,
      String(validation),
    ]);
  });

  it("fails closed when the validation account does not exist", async () => {
    const reader = fakeReader({});
    const [source] = await findAssociatedTokenPda({
      owner: address(OWNER),
      mint: address(WTGXX.mint),
      tokenProgram: address(TOKEN_2022),
    });
    await expect(
      resolveTransferHookAccounts(reader, {
        hookProgram: address(HOOK),
        mint: address(WTGXX.mint),
        source,
        destination: source,
        owner: address(OWNER),
        amount: 1n,
      })
    ).rejects.toThrowError(SdpWisdomTreeError);
  });

  it("surfaces a missing compliance account (account-data seed) as HOOK_UNRESOLVED", async () => {
    // An entry whose PDA seed slices data out of execute account 3 (the owner):
    // the owner's account does not exist in the fake chain, which is exactly
    // what an unverified wallet looks like to a compliance hook.
    const entry = new Uint8Array(35);
    entry[0] = 1;
    entry[1] = 4; // account-data seed tag
    entry[2] = 3; // execute account index 3 = owner
    entry[3] = 0; // data offset
    entry[4] = 8; // length
    const { source, destination, reader } = await fixtures([entry]);

    const refusal = await resolveTransferHookAccounts(reader, {
      hookProgram: address(HOOK),
      mint: address(WTGXX.mint),
      source,
      destination,
      owner: address(OWNER),
      amount: 1n,
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(refusal).toBeInstanceOf(SdpWisdomTreeError);
    expect((refusal as SdpWisdomTreeError).code).toBe("HOOK_UNRESOLVED");
    expect((refusal as SdpWisdomTreeError).message).toMatch(/not been verified/);
  });
});

describe("buildWisdomTreeRedemptionPlan", () => {
  it("appends the resolved hook accounts to the Token-2022 transfer", async () => {
    const validation = await deriveExtraAccountMetasAddress(address(HOOK), address(WTGXX.mint));
    const [onReceiptFundAta] = await findAssociatedTokenPda({
      owner: address(ON_RECEIPT),
      mint: address(WTGXX.mint),
      tokenProgram: address(TOKEN_2022),
    });
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      [String(onReceiptFundAta)]: { owner: TOKEN_2022, data: tokenAccountData(0n) },
      [String(validation)]: { owner: HOOK, data: metaListAccount([literalEntry(USDC)]) },
    });

    const plan = await buildWisdomTreeRedemptionPlan(reader, runtime, {
      fund: WTGXX,
      owner: createNoopSigner(address(OWNER)),
      onReceiptWallet: address(ON_RECEIPT),
      depositMint: address(USDC),
      shares: "12.5",
    });

    expect(plan.accepted).toEqual({ shares: "12.5" });
    expect(plan.assetIdentity).toEqual({
      depositTokenMint: address(USDC),
      shareMint: address(WTGXX.mint),
    });
    const transfer = plan.instructions.at(-1);
    expect(String(transfer?.programAddress)).toBe(TOKEN_2022);
    const tail = (transfer?.accounts ?? []).slice(-3).map((account) => String(account.address));
    expect(tail).toEqual([USDC, HOOK, String(validation)]);
  });

  it("resolves account-data seeds against an ATA created earlier in the plan", async () => {
    const validation = await deriveExtraAccountMetasAddress(address(HOOK), address(WTGXX.mint));
    const [expectedCompliancePda] = await getProgramDerivedAddress({
      programAddress: address(HOOK),
      seeds: [encoder.encode(address(ON_RECEIPT))],
    });
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      [String(validation)]: {
        owner: HOOK,
        data: metaListAccount([destinationOwnerPdaEntry()]),
      },
      // The destination ATA is deliberately absent: the plan creates it.
    });

    const plan = await buildWisdomTreeRedemptionPlan(reader, runtime, {
      fund: WTGXX,
      owner: createNoopSigner(address(OWNER)),
      onReceiptWallet: address(ON_RECEIPT),
      depositMint: address(USDC),
      shares: "1",
    });

    expect(plan.instructions).toHaveLength(2);
    const transfer = plan.instructions[1];
    expect((transfer.accounts ?? []).slice(-3).map((account) => String(account.address))).toEqual([
      String(expectedCompliancePda),
      HOOK,
      String(validation),
    ]);
  });

  it("refuses a hook entry that demands an extra signer", async () => {
    const validation = await deriveExtraAccountMetasAddress(address(HOOK), address(WTGXX.mint));
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      [String(validation)]: {
        owner: HOOK,
        data: metaListAccount([literalEntry(USDC, { isSigner: true })]),
      },
    });

    await expect(
      buildWisdomTreeRedemptionPlan(reader, runtime, {
        fund: WTGXX,
        owner: createNoopSigner(address(OWNER)),
        onReceiptWallet: address(ON_RECEIPT),
        depositMint: address(USDC),
        shares: "1",
      })
    ).rejects.toThrowError(/demands a signature/);
  });
});
