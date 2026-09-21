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
import {
  extraAccountMetaListAccount,
  fakeReader,
  literalHookEntry,
  tokenAccountData,
  wtgxxMintAccountData,
} from "./fixtures.test-helper";
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

/**
 * PDA on an EXTERNAL program taken from an execute-key index (discriminator
 * `128 + programIndex`, the spl-tlv-account-resolution external-program form),
 * seeded from that program's literal name and the mint's account key.
 */
function externalProgramPdaEntry(programIndex: number, literalSeed: string) {
  const entry = new Uint8Array(35);
  entry[0] = 128 + programIndex;
  const seedBytes = new TextEncoder().encode(literalSeed);
  let offset = 1;
  entry[offset] = 1; // literal seed tag
  entry[offset + 1] = seedBytes.length;
  entry.set(seedBytes, offset + 2);
  offset += 2 + seedBytes.length;
  entry[offset] = 3; // account-key seed tag
  entry[offset + 1] = 1; // execute index 1 = the mint
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
      [String(validation)]: { owner: HOOK, data: extraAccountMetaListAccount(entries) },
    });
    return { validation, source, destination, reader };
  }

  it("resolves literal and PDA-recipe entries and appends program + validation last", async () => {
    const { validation, source, destination, reader } = await fixtures([
      literalHookEntry(USDC),
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

  it("surfaces a missing compliance account (account-data seed) as WITHDRAW_REFUSED", async () => {
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
    expect((refusal as SdpWisdomTreeError).code).toBe("WITHDRAW_REFUSED");
    expect((refusal as SdpWisdomTreeError).message).toMatch(/not been verified/);
  });

  it("resolves an external-program entry whose program comes from an execute-key index", async () => {
    // Discriminator 128+3: the PDA's program is execute account 3 — the owner.
    const { validation, source, destination, reader } = await fixtures([
      externalProgramPdaEntry(3, "wt-external"),
    ]);

    const accounts = await resolveTransferHookAccounts(reader, {
      hookProgram: address(HOOK),
      mint: address(WTGXX.mint),
      source,
      destination,
      owner: address(OWNER),
      amount: 1n,
    });

    const [expectedPda] = await getProgramDerivedAddress({
      programAddress: address(OWNER),
      seeds: ["wt-external", encoder.encode(address(WTGXX.mint))],
    });
    // The external PDA, then hook program, then validation — one extra total.
    expect(accounts.map((account) => String(account.address))).toEqual([
      String(expectedPda),
      HOOK,
      String(validation),
    ]);
  });

  it("refuses an external-program entry pointing past the resolved accounts", async () => {
    // Index 9 does not exist: five base accounts plus zero prior extras.
    const { source, destination, reader } = await fixtures([externalProgramPdaEntry(9, "wt-x")]);

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
    expect((refusal as SdpWisdomTreeError).code).toBe("WITHDRAW_REFUSED");
    expect((refusal as SdpWisdomTreeError).message).toMatch(/index 9/);
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
      [String(validation)]: {
        owner: HOOK,
        data: extraAccountMetaListAccount([literalHookEntry(USDC)]),
      },
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
        data: extraAccountMetaListAccount([destinationOwnerPdaEntry()]),
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
        data: extraAccountMetaListAccount([literalHookEntry(USDC, { isSigner: true })]),
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

  it("reproduces the measured WTGXX hook layout shape offline (11 accounts)", async () => {
    // The live list measured 2026-08-28: a literal-seeded compliance-config
    // PDA, two literal accounts, and two account-data-seeded PDAs on an
    // external program keyed by the source/dest owners. The byte-exact list
    // stays with the opt-in surfpool run; this offline reconstruction pins the
    // SHAPE — the 11-account layout and the indexes the smoke test hardcodes
    // (4 = compliance config, 7 = source credential, 8 = destination
    // credential) — so index arithmetic regresses here, not on mainnet.
    const validation = await deriveExtraAccountMetasAddress(address(HOOK), address(WTGXX.mint));
    // Execute keys grow as entries resolve: the five base accounts occupy
    // indexes 0-4, and each resolved extra is appended (config PDA = 5, the
    // literals = 6 and 7, the credentials = 8 and 9). The measured list seeds
    // both credential PDAs from a program taken off that grown list.
    const sourceOwnerCredentialEntry = new Uint8Array(35);
    sourceOwnerCredentialEntry[0] = 128 + 6; // external program = execute index 6, the first literal
    sourceOwnerCredentialEntry[1] = 4; // account-data seed tag
    sourceOwnerCredentialEntry[2] = 0; // execute index 0 = source token account
    sourceOwnerCredentialEntry[3] = 32; // token-account owner field offset
    sourceOwnerCredentialEntry[4] = 32;
    const destinationOwnerCredentialEntry = new Uint8Array(35);
    destinationOwnerCredentialEntry[0] = 128 + 6; // same external program
    destinationOwnerCredentialEntry[1] = 4;
    destinationOwnerCredentialEntry[2] = 2; // execute index 2 = destination token account
    destinationOwnerCredentialEntry[3] = 32;
    destinationOwnerCredentialEntry[4] = 32;
    const reader = fakeReader({
      [WTGXX.mint]: { owner: TOKEN_2022, data: wtgxxMintAccountData() },
      [String(validation)]: {
        owner: HOOK,
        data: extraAccountMetaListAccount([
          pdaEntry("wt-compliance-config"),
          literalHookEntry(OWNER),
          literalHookEntry(USDC),
          sourceOwnerCredentialEntry,
          destinationOwnerCredentialEntry,
        ]),
      },
      // Both ATAs exist (no create instruction), each naming its wallet in the
      // owner field the account-data seeds slice.
      [await ata(OWNER, WTGXX.mint, TOKEN_2022)]: {
        owner: TOKEN_2022,
        data: tokenAccountWithOwner(OWNER, 1n),
      },
      [await ata(ON_RECEIPT, WTGXX.mint, TOKEN_2022)]: {
        owner: TOKEN_2022,
        data: tokenAccountWithOwner(ON_RECEIPT, 0n),
      },
    });

    const plan = await buildWisdomTreeRedemptionPlan(reader, runtime, {
      fund: WTGXX,
      owner: createNoopSigner(address(OWNER)),
      onReceiptWallet: address(ON_RECEIPT),
      depositMint: address(USDC),
      shares: "1",
    });

    const accounts = plan.instructions.at(-1)?.accounts ?? [];
    expect(accounts).toHaveLength(11);
    const [expectedConfigPda] = await getProgramDerivedAddress({
      programAddress: address(HOOK),
      seeds: ["wt-compliance-config", encoder.encode(address(WTGXX.mint))],
    });
    // The external program is execute index 6 — the first literal account.
    const [expectedSourceCredential] = await getProgramDerivedAddress({
      programAddress: address(OWNER),
      seeds: [encoder.encode(address(OWNER))],
    });
    const [expectedDestinationCredential] = await getProgramDerivedAddress({
      programAddress: address(OWNER),
      seeds: [encoder.encode(address(ON_RECEIPT))],
    });
    expect(accounts.map((account) => String(account.address))).toEqual([
      // The five execute accounts, in interface order.
      await ata(OWNER, WTGXX.mint, TOKEN_2022), // 0: source fund ATA
      address(WTGXX.mint), // 1: mint
      await ata(ON_RECEIPT, WTGXX.mint, TOKEN_2022), // 2: destination fund ATA
      OWNER, // 3: owner
      String(expectedConfigPda), // 4: compliance config — pinned by the smoke run
      OWNER, // 5: first literal
      USDC, // 6: second literal
      String(expectedSourceCredential), // 7: source credential — pinned by the smoke run
      String(expectedDestinationCredential), // 8: destination credential — pinned
      HOOK, // 9: hook program
      String(validation), // 10: validation account
    ]);
  });
});

async function ata(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const [derived] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: address(tokenProgram),
  });
  return String(derived);
}

/** A token-account image whose owner field names `owner`, as live ATAs do. */
function tokenAccountWithOwner(owner: string, baseUnits: bigint): Uint8Array {
  const data = tokenAccountData(baseUnits);
  data.set(encoder.encode(address(owner)), 32);
  return data;
}
