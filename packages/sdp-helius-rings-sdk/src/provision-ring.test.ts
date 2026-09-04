import { createHash } from "node:crypto";
import { ViewingKey } from "@heliuslabs/zolana";
import type { Bytes32 } from "@heliuslabs/zolana/interface";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Codec,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getProgramDerivedAddress,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  findAddressLookupTablePda,
  getCreateLookupTableInstruction,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_OWNER } from "./test/shielded-identity-fixtures.js";

const createAuditorKey = vi.fn();
const fetchRingLookupTable = vi.fn();
const buildRingLookupTableTransaction = vi.fn();

vi.mock("@heliuslabs/zolana/ring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana/ring")>()),
  RingRpc: class {
    createAuditorKey(...args: unknown[]) {
      return createAuditorKey(...args);
    }
  },
  fetchRingLookupTable: (...args: unknown[]) => fetchRingLookupTable(...args),
  buildRingLookupTableTransaction: (...args: unknown[]) => buildRingLookupTableTransaction(...args),
}));

const { ringAuthAddress, ringProgramDataAddress, readerKeyBytes } = await import(
  "@heliuslabs/zolana/ring"
);
const realRing =
  await vi.importActual<typeof import("@heliuslabs/zolana/ring")>("@heliuslabs/zolana/ring");
const { provisionCustomRing } = await import("./provision-ring.js");

const RING_PROGRAM = "Stake11111111111111111111111111111111111111" as Address;
const AUTHORITY = TEST_OWNER as Address;
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SHIELDED_POOL = "zkpo1WxqYNGfM2ax4rvjqDLXZdRuosxjMU3893vSjKA";
const TREE = "trEEbaNobcTESNmtsPBj3FX27q5sDCQePV2kb12FYho" as Address;
const RECORDED_TABLE = "LookupTab1e11111111111111111111111111111111";
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7));
const GENESIS_HASH = getBase58Codec().decode(new Uint8Array(32).fill(9));

/** A real P-256 point, because the create-config builder validates and encodes it. */
const AUDITOR = ViewingKey.fromBytes(new Uint8Array(32).fill(9) as Bytes32).publicKey();

const encodeAddress = (value: Address) => new Uint8Array(getAddressEncoder().encode(value));

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Rust `tag::GRANT_READ_ACCESS`, asserted on the bytes custody signs. */
const GRANT_READ_ACCESS_TAG = 4;

/** `UpgradeableLoaderState::Program`: u32 tag 2, then the programdata address. */
function programAccount(programDataAddress: Address) {
  const data = new Uint8Array(36);
  data[0] = 2;
  data.set(encodeAddress(programDataAddress), 4);
  return { owner: UPGRADEABLE_LOADER, data, lamports: 1n };
}

/** `UpgradeableLoaderState::ProgramData`: u32 tag 3, u64 slot, then Option<authority>. */
function programDataAccount(authority: Address | null) {
  const data = new Uint8Array(45);
  data[0] = 3;
  if (authority !== null) {
    data[12] = 1;
    data.set(encodeAddress(authority), 13);
  }
  return { owner: UPGRADEABLE_LOADER, data, lamports: 1n };
}

/** The ring's 67-byte config: discriminator, authority, compressed auditor key, bump. */
function configAccount(authority: Address, bump: number) {
  const data = new Uint8Array(67);
  data[0] = 1;
  data.set(encodeAddress(authority), 1);
  data.set(AUDITOR.toBytes(), 33);
  data[66] = bump;
  return { owner: RING_PROGRAM, data, lamports: 1n };
}

/** The 36-byte read-access record: discriminator, scheme-tagged reader key, bump. */
function grantRecordAccount(bump: number) {
  const data = new Uint8Array(36);
  data[0] = 2;
  data.set(readerKeyBytes(AUTHORITY), 1);
  data[35] = bump;
  return { owner: RING_PROGRAM, data, lamports: 1n };
}

async function derivedAddresses() {
  const [
    [configAddress, configBump],
    [grantRecord, grantRecordBump],
    programDataAddress,
    ringAuth,
  ] = await Promise.all([
    getProgramDerivedAddress({
      programAddress: RING_PROGRAM,
      seeds: [new TextEncoder().encode("config")],
    }),
    getProgramDerivedAddress({
      programAddress: RING_PROGRAM,
      seeds: [
        new TextEncoder().encode("reader"),
        createHash("sha256").update(readerKeyBytes(AUTHORITY)).digest(),
      ],
    }),
    ringProgramDataAddress(RING_PROGRAM),
    ringAuthAddress(RING_PROGRAM),
  ]);
  return { configAddress, configBump, grantRecord, grantRecordBump, programDataAddress, ringAuth };
}

/** The pool-owned ring-auth marker account SPP registration creates. */
function ringAuthAccount() {
  return { owner: SHIELDED_POOL, data: new Uint8Array(1), lamports: 1n };
}

function harness(accounts: Map<string, unknown>) {
  const client = {
    tree: TREE,
    getAccount: vi.fn(async (target: string) => accounts.get(target)),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n })),
    confirmTransaction: vi.fn(async () => {}),
    solanaRpc: {
      getGenesisHash: () => ({ send: async () => GENESIS_HASH }),
      getSlot: () => ({ send: async () => 42n }),
    },
  };
  const deps = {
    client: client as never,
    ringRpcUrl: "https://ring-rpc.example",
    signTransaction: vi.fn(async (unsignedTxBase64: string, _owner: string) => unsignedTxBase64),
    signMessage: vi.fn(async () => getBase64Codec().decode(new Uint8Array(64).fill(1))),
    submitTransaction: vi.fn(async () => "sig"),
    recordLookupTable: vi.fn(async () => {}),
  };
  return { client, deps };
}

/**
 * Harness over a fully-registered ring: program, config, ring-auth and reader
 * grant all on chain, with the upgrade authority matching the config's.
 */
async function registeredHarness(upgradeAuthority: Address = AUTHORITY) {
  const derived = await derivedAddresses();
  const { deps, client } = harness(
    new Map<string, unknown>([
      [RING_PROGRAM, programAccount(derived.programDataAddress)],
      [derived.programDataAddress, programDataAccount(upgradeAuthority)],
      [derived.configAddress, configAccount(AUTHORITY, derived.configBump)],
      [derived.ringAuth, ringAuthAccount()],
      [derived.grantRecord, grantRecordAccount(derived.grantRecordBump)],
    ])
  );
  return { deps, client, ...derived };
}

/** The one instruction of an unsigned transaction handed to custody. */
function soleInstruction(unsignedTxBase64: string) {
  const transaction = getTransactionDecoder().decode(getBase64Codec().encode(unsignedTxBase64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const [instruction] = getInstructionsFromCompiledTransactionMessage(message);
  return instruction;
}

describe("provisionCustomRing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAuditorKey.mockResolvedValue({ auditorPublicKey: AUDITOR });
    // A landed or recorded table verifies complete by default; the not-found
    // and incomplete paths override per test.
    fetchRingLookupTable.mockResolvedValue(Object.freeze([]));
    buildRingLookupTableTransaction.mockImplementation(realRing.buildRingLookupTableTransaction);
  });

  it("refuses a ring id that is not an address", async () => {
    const { deps } = harness(new Map());
    await expect(
      provisionCustomRing(deps, { ringProgramId: "not-a-solana-address" })
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("brings a fresh ring up end to end and returns the published auditor key", async () => {
    const {
      configAddress,
      configBump,
      grantRecord,
      grantRecordBump,
      programDataAddress,
      ringAuth,
    } = await derivedAddresses();
    const accounts = new Map<string, unknown>([
      [RING_PROGRAM, programAccount(programDataAddress)],
      [programDataAddress, programDataAccount(AUTHORITY)],
    ]);
    const { deps } = harness(accounts);
    // Each landed transaction materializes what the next read is gated on.
    deps.submitTransaction.mockImplementation(async () => {
      if (!accounts.has(configAddress)) {
        accounts.set(configAddress, configAccount(AUTHORITY, configBump));
      } else if (!accounts.has(ringAuth)) {
        accounts.set(ringAuth, ringAuthAccount());
      } else if (!accounts.has(grantRecord)) {
        accounts.set(grantRecord, grantRecordAccount(grantRecordBump));
      }
      return "sig";
    });

    const result = await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM });

    expect(result.auditorPublicKeyHex).toBe(hex(AUDITOR.toUncompressed()));
    // Create-config, SPP registration, the initial reader grant, then the
    // ring's lookup table — all as the upgrade authority.
    expect(deps.signTransaction).toHaveBeenCalledTimes(4);
    expect(deps.signTransaction.mock.calls.map(([, owner]) => owner)).toEqual([
      AUTHORITY,
      AUTHORITY,
      AUTHORITY,
      AUTHORITY,
    ]);
    const grant = soleInstruction(deps.signTransaction.mock.calls[2]?.[0] as string);
    expect(grant?.programAddress).toBe(RING_PROGRAM);
    expect(grant?.data?.[0]).toBe(GRANT_READ_ACCESS_TAG);
    // The reader in the signed bytes is the authority itself, nobody else.
    expect([...(grant?.data ?? [])].slice(1)).toEqual([...readerKeyBytes(AUTHORITY)]);
    // The table is recorded the moment it confirms, before the result returns,
    // and the result carries the same address.
    expect(result.lookupTableAddress).toBeDefined();
    expect(deps.recordLookupTable).toHaveBeenCalledWith(result.lookupTableAddress);
    const [request] = createAuditorKey.mock.calls[0] as [
      { ringProgramId: string; authority: { address: string } },
    ];
    expect(request.ringProgramId).toBe(RING_PROGRAM);
    expect(request.authority.address).toBe(AUTHORITY);
  });

  it("adopts a fully-registered ring once custody proves the config authority", async () => {
    const { deps } = await registeredHarness();

    const result = await provisionCustomRing(deps, {
      ringProgramId: RING_PROGRAM,
      lookupTableAddress: RECORDED_TABLE,
    });

    // Re-keying a live ring would orphan its auditor, so nothing is rewritten,
    // and a complete recorded table is adopted rather than rented again.
    expect(result.auditorPublicKeyHex).toBe(hex(AUDITOR.toUncompressed()));
    expect(result.lookupTableAddress).toBe(RECORDED_TABLE);
    expect(createAuditorKey).not.toHaveBeenCalled();
    expect(deps.signTransaction).not.toHaveBeenCalled();
    // Adoption lands no transaction, so the challenge is the only proof that
    // this project's custody administers the ring.
    expect(deps.signMessage).toHaveBeenCalledTimes(1);
    expect(deps.signMessage).toHaveBeenCalledWith(expect.any(String), AUTHORITY);
  });

  it("refuses to adopt a ring whose program another party can upgrade", async () => {
    // Custody holds the config authority, but the program's upgrade authority
    // is someone else's key: they could swap the code the notes deposit
    // under, so adoption must refuse before anything is signed or activated.
    const foreignAuthority = "Vote111111111111111111111111111111111111111" as Address;
    const { deps } = await registeredHarness(foreignAuthority);

    await expect(
      provisionCustomRing(deps, { ringProgramId: RING_PROGRAM, lookupTableAddress: RECORDED_TABLE })
    ).rejects.toMatchObject({ code: "conflict" });
    expect(deps.signTransaction).not.toHaveBeenCalled();
    expect(deps.signMessage).not.toHaveBeenCalled();
  });

  it("rents the lookup table for an adopted ring that lacks one", async () => {
    const { deps } = await registeredHarness();

    const result = await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM });

    // The challenge still ran (no ring-program transaction landed), and the
    // one signed transaction is the table's create+extend.
    expect(deps.signMessage).toHaveBeenCalledTimes(1);
    expect(deps.signTransaction).toHaveBeenCalledTimes(1);
    expect(result.lookupTableAddress).toBeDefined();
    expect(deps.recordLookupTable).toHaveBeenCalledWith(result.lookupTableAddress);
  });

  it("recreates the table when the recorded create never landed", async () => {
    const { deps } = await registeredHarness();
    fetchRingLookupTable
      .mockRejectedValueOnce(
        new realRing.RingError("RING_LOOKUP_TABLE_NOT_FOUND", {
          details: { address: RECORDED_TABLE },
        })
      )
      .mockResolvedValue(Object.freeze([]));

    const result = await provisionCustomRing(deps, {
      ringProgramId: RING_PROGRAM,
      lookupTableAddress: RECORDED_TABLE,
    });

    expect(deps.signTransaction).toHaveBeenCalledTimes(1);
    expect(result.lookupTableAddress).not.toBe(RECORDED_TABLE);
  });

  it("refuses a recorded table that exists but lacks the ring's addresses", async () => {
    const { deps } = await registeredHarness();
    fetchRingLookupTable.mockRejectedValue(
      new realRing.RingError("RING_LOOKUP_TABLE_INCOMPLETE", {
        details: { address: RECORDED_TABLE, missing: [TREE] },
      })
    );

    // Our gate lands create+extend atomically, so a live-but-short table was
    // not created by this bring-up; adopting it would break the wire policy's
    // locally derived table model.
    await expect(
      provisionCustomRing(deps, { ringProgramId: RING_PROGRAM, lookupTableAddress: RECORDED_TABLE })
    ).rejects.toMatchObject({ code: "conflict" });
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });

  it("refuses to sign a lookup-table transaction extending anything but the ring's addresses", async () => {
    const { deps } = await registeredHarness();
    // A builder gone wrong: the real create+extend pair, but the address
    // vector smuggles a foreign account in place of the shielded pool.
    const recentSlot = 42n;
    const pda = await findAddressLookupTablePda({ authority: AUTHORITY, recentSlot });
    const authority = createNoopSigner(AUTHORITY);
    const perturbed = [
      ...(await realRing.ringLookupTableAddresses({ ringProgramId: RING_PROGRAM, tree: TREE })),
    ];
    perturbed[2] = AUTHORITY;
    buildRingLookupTableTransaction.mockResolvedValue({
      transaction: compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayer(AUTHORITY, message),
          (message) =>
            setTransactionMessageLifetimeUsingBlockhash(
              { blockhash: BLOCKHASH as Blockhash, lastValidBlockHeight: 100n },
              message
            ),
          (message) =>
            appendTransactionMessageInstructions(
              [
                getCreateLookupTableInstruction({
                  address: pda,
                  authority: AUTHORITY,
                  payer: authority,
                  recentSlot,
                }),
                getExtendLookupTableInstruction({
                  address: pda[0],
                  authority,
                  payer: authority,
                  addresses: perturbed,
                }),
              ],
              message
            )
        )
      ),
      address: pda[0],
      slot: recentSlot,
    });

    await expect(provisionCustomRing(deps, { ringProgramId: RING_PROGRAM })).rejects.toMatchObject({
      code: "conflict",
      message: "refusing to sign a transaction that is not the expected ring lookup-table bring-up",
    });
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });

  it("resumes a run that died between config and SPP registration", async () => {
    const {
      configAddress,
      configBump,
      grantRecord,
      grantRecordBump,
      ringAuth,
      programDataAddress,
    } = await derivedAddresses();
    const accounts = new Map<string, unknown>([
      [RING_PROGRAM, programAccount(programDataAddress)],
      [programDataAddress, programDataAccount(AUTHORITY)],
      [configAddress, configAccount(AUTHORITY, configBump)],
    ]);
    const { deps } = harness(accounts);
    deps.submitTransaction.mockImplementation(async () => {
      if (!accounts.has(ringAuth)) {
        accounts.set(ringAuth, ringAuthAccount());
      } else {
        accounts.set(grantRecord, grantRecordAccount(grantRecordBump));
      }
      return "sig";
    });

    await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM });

    // Only the missing half runs, signed as the authority the config names,
    // plus the ring's lookup table.
    expect(createAuditorKey).not.toHaveBeenCalled();
    expect(deps.signTransaction).toHaveBeenCalledTimes(3);
    expect(deps.signTransaction.mock.calls.map(([, owner]) => owner)).toEqual([
      AUTHORITY,
      AUTHORITY,
      AUTHORITY,
    ]);
  });

  it("resumes by granting the initial reader when only the grant is missing", async () => {
    const { configAddress, configBump, ringAuth, programDataAddress } = await derivedAddresses();
    const { deps } = harness(
      new Map<string, unknown>([
        [RING_PROGRAM, programAccount(programDataAddress)],
        [programDataAddress, programDataAccount(AUTHORITY)],
        [configAddress, configAccount(AUTHORITY, configBump)],
        [ringAuth, ringAuthAccount()],
      ])
    );

    await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM });

    expect(createAuditorKey).not.toHaveBeenCalled();
    expect(deps.signTransaction).toHaveBeenCalledTimes(2);
    const grant = soleInstruction(deps.signTransaction.mock.calls[0]?.[0] as string);
    expect(grant?.data?.[0]).toBe(GRANT_READ_ACCESS_TAG);
  });

  it("refuses a ring id that is not a deployed upgradeable program", async () => {
    const { deps } = harness(new Map());
    await expect(provisionCustomRing(deps, { ringProgramId: RING_PROGRAM })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });

  it("refuses an immutable ring program", async () => {
    const { programDataAddress } = await derivedAddresses();
    const { deps } = harness(
      new Map<string, unknown>([
        [RING_PROGRAM, programAccount(programDataAddress)],
        [programDataAddress, programDataAccount(null)],
      ])
    );

    const error = await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as Error).message).toContain("immutable");
  });

  it("refuses a malformed custody message signature before anything is signed", async () => {
    const { programDataAddress } = await derivedAddresses();
    const { deps } = harness(
      new Map<string, unknown>([
        [RING_PROGRAM, programAccount(programDataAddress)],
        [programDataAddress, programDataAccount(AUTHORITY)],
      ])
    );
    deps.signMessage.mockResolvedValue(getBase64Codec().decode(new Uint8Array(10)));
    // The real request signer consumes the signature, so the mock has to.
    createAuditorKey.mockImplementation(
      async (input: { authority: { signMessages: (m: unknown[]) => Promise<unknown> } }) => {
        await input.authority.signMessages([{ content: new Uint8Array(32), signatures: {} }]);
        return { auditorPublicKey: AUDITOR };
      }
    );

    await expect(provisionCustomRing(deps, { ringProgramId: RING_PROGRAM })).rejects.toMatchObject({
      code: "gateway_unavailable",
    });
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });
});
