import { createHash } from "node:crypto";
import { ViewingKey } from "@heliuslabs/zolana";
import type { Bytes32 } from "@heliuslabs/zolana/interface";
import {
  type Address,
  getAddressEncoder,
  getBase58Codec,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getProgramDerivedAddress,
  getTransactionDecoder,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_OWNER } from "./test/shielded-identity-fixtures.js";

const createAuditorKey = vi.fn();

vi.mock("@heliuslabs/zolana/ring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana/ring")>()),
  RingRpc: class {
    createAuditorKey(...args: unknown[]) {
      return createAuditorKey(...args);
    }
  },
}));

const { ringAuthAddress, ringProgramDataAddress, readerKeyBytes } = await import(
  "@heliuslabs/zolana/ring"
);
const { provisionCustomRing } = await import("./provision-ring.js");

const RING_PROGRAM = "Stake11111111111111111111111111111111111111" as Address;
const AUTHORITY = TEST_OWNER as Address;
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SHIELDED_POOL = "zkpo1WxqYNGfM2ax4rvjqDLXZdRuosxjMU3893vSjKA";
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

function harness(accounts: Map<string, unknown>) {
  const client = {
    getAccount: vi.fn(async (target: string) => accounts.get(target)),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n })),
    confirmTransaction: vi.fn(async () => {}),
    solanaRpc: { getGenesisHash: () => ({ send: async () => GENESIS_HASH }) },
  };
  const deps = {
    client: client as never,
    ringRpcUrl: "https://ring-rpc.example",
    signTransaction: vi.fn(async (unsignedTxBase64: string, _owner: string) => unsignedTxBase64),
    signMessage: vi.fn(async () => getBase64Codec().decode(new Uint8Array(64).fill(1))),
    submitTransaction: vi.fn(async () => "sig"),
  };
  return { client, deps };
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
        accounts.set(ringAuth, { owner: SHIELDED_POOL, data: new Uint8Array(1), lamports: 1n });
      } else {
        accounts.set(grantRecord, grantRecordAccount(grantRecordBump));
      }
      return "sig";
    });

    const result = await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM });

    expect(result.auditorPublicKeyHex).toBe(hex(AUDITOR.toUncompressed()));
    // Create-config, SPP registration, then the initial reader grant, all as
    // the upgrade authority.
    expect(deps.signTransaction).toHaveBeenCalledTimes(3);
    expect(deps.signTransaction.mock.calls.map(([, owner]) => owner)).toEqual([
      AUTHORITY,
      AUTHORITY,
      AUTHORITY,
    ]);
    const grant = soleInstruction(deps.signTransaction.mock.calls[2]?.[0] as string);
    expect(grant?.programAddress).toBe(RING_PROGRAM);
    expect(grant?.data?.[0]).toBe(GRANT_READ_ACCESS_TAG);
    // The reader in the signed bytes is the authority itself, nobody else.
    expect([...(grant?.data ?? [])].slice(1)).toEqual([...readerKeyBytes(AUTHORITY)]);
    const [request] = createAuditorKey.mock.calls[0] as [
      { ringProgramId: string; authority: { address: string } },
    ];
    expect(request.ringProgramId).toBe(RING_PROGRAM);
    expect(request.authority.address).toBe(AUTHORITY);
  });

  it("adopts an existing fully-registered ring without signing anything", async () => {
    const { configAddress, configBump, grantRecord, grantRecordBump, ringAuth } =
      await derivedAddresses();
    const { deps } = harness(
      new Map<string, unknown>([
        [configAddress, configAccount(AUTHORITY, configBump)],
        [ringAuth, { owner: SHIELDED_POOL, data: new Uint8Array(1), lamports: 1n }],
        [grantRecord, grantRecordAccount(grantRecordBump)],
      ])
    );

    const result = await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM });

    // Re-keying a live ring would orphan its auditor, so nothing is rewritten.
    expect(result.auditorPublicKeyHex).toBe(hex(AUDITOR.toUncompressed()));
    expect(createAuditorKey).not.toHaveBeenCalled();
    expect(deps.signTransaction).not.toHaveBeenCalled();
  });

  it("resumes a run that died between config and SPP registration", async () => {
    const { configAddress, configBump, grantRecord, grantRecordBump, ringAuth } =
      await derivedAddresses();
    const accounts = new Map<string, unknown>([
      [configAddress, configAccount(AUTHORITY, configBump)],
    ]);
    const { deps } = harness(accounts);
    deps.submitTransaction.mockImplementation(async () => {
      if (!accounts.has(ringAuth)) {
        accounts.set(ringAuth, { owner: SHIELDED_POOL, data: new Uint8Array(1), lamports: 1n });
      } else {
        accounts.set(grantRecord, grantRecordAccount(grantRecordBump));
      }
      return "sig";
    });

    await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM });

    // Only the missing half runs, signed as the authority the config names.
    expect(createAuditorKey).not.toHaveBeenCalled();
    expect(deps.signTransaction).toHaveBeenCalledTimes(2);
    expect(deps.signTransaction.mock.calls.map(([, owner]) => owner)).toEqual([
      AUTHORITY,
      AUTHORITY,
    ]);
  });

  it("resumes by granting the initial reader when only the grant is missing", async () => {
    const { configAddress, configBump, ringAuth } = await derivedAddresses();
    const { deps } = harness(
      new Map<string, unknown>([
        [configAddress, configAccount(AUTHORITY, configBump)],
        [ringAuth, { owner: SHIELDED_POOL, data: new Uint8Array(1), lamports: 1n }],
      ])
    );

    await provisionCustomRing(deps, { ringProgramId: RING_PROGRAM });

    expect(createAuditorKey).not.toHaveBeenCalled();
    expect(deps.signTransaction).toHaveBeenCalledTimes(1);
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
