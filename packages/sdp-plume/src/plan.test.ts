import {
  assertFireblocksProposal,
  assertFireblocksTransaction,
} from "@sdp/custody/testing/fireblocks-proposal";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { deriveAssociatedTokenAddress } from "@sdp/solana/address";
import { PLUME_PROGRAMS, PLUME_VAULTS } from "@sdp/types/plume-programs";
import { SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types/well-known-tokens";
import {
  AccountRole,
  type Address,
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstruction,
  assertIsTransactionWithinSizeLimit,
  blockhash,
  compileTransaction,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  getU32Encoder,
  getU64Encoder,
  type Instruction,
  partiallySignTransactionMessageWithSigners,
  type RpcTransport,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cancelCompose, evmWord, mintHook, redeemCompose } from "./abi";
import { admitPlumeTransaction } from "./plan";

const vault = PLUME_VAULTS[0];
const mint = wellKnownMint("USDC", "mainnet-beta");
if (vault === undefined || mint === undefined)
  throw new Error("Test requires the pinned nOPAL deployment");
const usdc = mint;
const lifetime = {
  blockhash: blockhash("29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2"),
  lastValidBlockHeight: 150n,
};
function rpc(): SolanaRpc {
  const transport: RpcTransport = async <T>({
    payload,
  }: Parameters<RpcTransport>[0]): Promise<T> => {
    const p = z
      .object({
        method: z.enum(["getLatestBlockhash", "isBlockhashValid"]),
        id: z.union([z.string(), z.number()]),
      })
      .parse(payload);
    const result =
      p.method === "getLatestBlockhash"
        ? {
            context: { slot: 10 },
            value: { blockhash: lifetime.blockhash, lastValidBlockHeight: 150 },
          }
        : { context: { slot: 10 }, value: true };
    // SAFETY: this test transport supplies exactly the JSON-RPC envelope for these two Kit methods.
    return { jsonrpc: "2.0", id: p.id, result } as T;
  };
  return createSolanaRpcFromTransport(transport);
}

async function fixture(
  overrides: {
    atoms?: bigint;
    hookOwner?: string;
    feePayer?: string;
    extraInstruction?: Instruction;
    badProtocolSignature?: boolean;
  } = {}
) {
  const [owner, keeper, event] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  const usdcAta = await deriveAssociatedTokenAddress(
    owner.address,
    usdc,
    SPL_TOKEN_PROGRAMS["spl-token"]
  );
  const dummy = address("So11111111111111111111111111111111111111112");
  const accounts: Array<{ address: Address; role: AccountRole }> = Array.from(
    { length: 18 },
    () => ({ address: dummy, role: AccountRole.READONLY })
  );
  accounts[0] = { address: owner.address, role: AccountRole.READONLY_SIGNER };
  accounts[1] = { address: keeper.address, role: AccountRole.WRITABLE_SIGNER };
  accounts[3] = { address: usdcAta, role: AccountRole.WRITABLE };
  accounts[10] = { address: address(usdc), role: AccountRole.WRITABLE };
  accounts[11] = { address: event.address, role: AccountRole.WRITABLE_SIGNER };
  accounts[12] = {
    address: address(PLUME_PROGRAMS.messageTransmitter),
    role: AccountRole.READONLY,
  };
  accounts[13] = { address: address(PLUME_PROGRAMS.tokenMessenger), role: AccountRole.READONLY };
  accounts[14] = { address: address(SPL_TOKEN_PROGRAMS["spl-token"]), role: AccountRole.READONLY };
  accounts[15] = {
    address: address("11111111111111111111111111111111"),
    role: AccountRole.READONLY,
  };
  accounts[17] = accounts[13];
  const atoms = overrides.atoms === undefined ? 1_000_000n : overrides.atoms;
  const hook = mintHook(
    vault,
    overrides.hookOwner === undefined ? owner.address : overrides.hookOwner,
    usdcAta,
    atoms
  );
  const data = Buffer.concat([
    Uint8Array.of(111, 245, 62, 131, 204, 108, 223, 155),
    Buffer.from(getU64Encoder().encode(atoms)),
    Buffer.from(getU32Encoder().encode(22)),
    evmWord(vault.relayer),
    evmWord(vault.relayer),
    Buffer.from(getU64Encoder().encode(0n)),
    Buffer.from(getU32Encoder().encode(2000)),
    Buffer.from(getU32Encoder().encode(hook.length)),
    hook,
  ]);
  const message = appendTransactionMessageInstruction(
    { programAddress: address(PLUME_PROGRAMS.tokenMessenger), accounts, data },
    setTransactionMessageLifetimeUsingBlockhash(
      lifetime,
      setTransactionMessageFeePayer(
        overrides.feePayer === undefined ? owner.address : address(overrides.feePayer),
        createTransactionMessage({ version: 0 })
      )
    )
  );
  const finalMessage =
    overrides.extraInstruction === undefined
      ? message
      : appendTransactionMessageInstruction(overrides.extraInstruction, message);
  const signed = await partiallySignTransactionMessageWithSigners(
    addSignersToTransactionMessage(
      overrides.badProtocolSignature ? [keeper] : [keeper, event],
      finalMessage
    )
  );
  return {
    owner,
    keeper,
    event,
    bytes: Buffer.from(getTransactionEncoder().encode(signed)),
    input: {
      vault,
      owner: owner.address,
      feePayer: owner.address,
      depositMint: usdc,
      atoms: 1_000_000n,
      canonicalAmount: "1",
      mode: "mint" as const,
      transactionBase64: Buffer.from(getTransactionEncoder().encode(signed)).toString("base64"),
    },
  };
}

describe("Plume transaction admission", () => {
  it("retains both protocol signatures and the exact original message", async () => {
    const f = await fixture();
    const plan = await admitPlumeTransaction(rpc(), f.input);
    expect(plan.providerTransaction?.transactionBase64).toBe(f.bytes.toString("base64"));
    expect(plan.providerTransaction?.additionalSigners).toEqual([
      f.keeper.address,
      f.event.address,
    ]);
    expect(plan.accepted).toEqual({ amount: "1" });
    const transaction = {
      ...getTransactionDecoder().decode(f.bytes),
      lifetimeConstraint: lifetime,
    };
    assertIsTransactionWithinSizeLimit(transaction);
    await assertFireblocksTransaction(transaction, f.owner, plan.cluster);
  });
  it("rejects a provider-selected input amount", async () => {
    const f = await fixture({ atoms: 2_000_000n });
    await expect(admitPlumeTransaction(rpc(), f.input)).rejects.toThrow("approved request");
  });
  it("rejects a substituted receiver in the CCTP hook", async () => {
    const f = await fixture({ hookOwner: "11111111111111111111111111111111" });
    await expect(admitPlumeTransaction(rpc(), f.input)).rejects.toThrow("mint hook");
  });
  it("rejects an absent ephemeral event-account signature", async () => {
    const f = await fixture({ badProtocolSignature: true });
    await expect(admitPlumeTransaction(rpc(), f.input)).rejects.toThrow("protocol signature");
  });
  it("rejects extra debit instructions even from a recognized system program", async () => {
    const f = await fixture({
      extraInstruction: {
        programAddress: address("11111111111111111111111111111111"),
        data: Uint8Array.of(2),
        accounts: [],
      },
    });
    await expect(admitPlumeTransaction(rpc(), f.input)).rejects.toThrow("unapproved");
  });
  it("rejects a substituted fee payer", async () => {
    const f = await fixture({ feePayer: "11111111111111111111111111111111" });
    await expect(admitPlumeTransaction(rpc(), f.input)).rejects.toThrow("approved request");
  });
  it("encodes the receiver wallet separately from the refund token account", () => {
    const hook = mintHook(
      vault,
      "11111111111111111111111111111111",
      "So11111111111111111111111111111111111111112",
      1_000_000n
    );
    expect(Buffer.from(hook).subarray(20, 24).toString("hex")).toBe("fe030ec4");
    expect(hook.length).toBe(472);
    const compose = redeemCompose("11111111111111111111111111111111", 1_000_000n, "standard");
    expect(compose.length).toBe(416);
    expect(BigInt(`0x${Buffer.from(compose).subarray(64, 96).toString("hex")}`)).toBe(30370n);
  });
});

async function redemptionFixture(mode: "standard" | "instant" | "cancel", wrongReceiver = false) {
  const owner = await generateKeyPairSigner();
  const shareAta = await deriveAssociatedTokenAddress(
    owner.address,
    vault.shareMint,
    SPL_TOKEN_PROGRAMS["spl-token"]
  );
  const usdcAta = await deriveAssociatedTokenAddress(
    owner.address,
    usdc,
    SPL_TOKEN_PROGRAMS["spl-token"]
  );
  const atoms = mode === "cancel" ? 0n : 1_000_000n;
  const composer = mode === "cancel" ? `0x${"12".repeat(20)}` : vault.redemptionComposer;
  const receiver = wrongReceiver ? "11111111111111111111111111111111" : usdcAta;
  const compose =
    mode === "cancel" ? cancelCompose(receiver, 0n) : redeemCompose(receiver, atoms, mode);
  const u64 = (value: bigint) => Buffer.from(getU64Encoder().encode(value));
  const u32 = (value: number) => Buffer.from(getU32Encoder().encode(value));
  const data = Buffer.concat([
    Buffer.from([102, 251, 20, 187, 65, 75, 12, 69]),
    u32(30370),
    evmWord(composer),
    u64(atoms),
    u64(atoms),
    u32(0),
    Buffer.from([1]),
    u32(compose.length),
    compose,
    u64(1_000n),
    u64(0n),
  ]);
  const keys = [
    owner.address,
    owner.address,
    vault.oftStore,
    shareAta,
    vault.tokenEscrow,
    vault.shareMint,
    SPL_TOKEN_PROGRAMS["spl-token"],
    owner.address,
    PLUME_PROGRAMS.oft,
  ];
  const instruction: Instruction = {
    programAddress: address(PLUME_PROGRAMS.oft),
    accounts: keys.map((key, index) => ({
      address: address(key),
      role: index === 0 ? AccountRole.READONLY_SIGNER : AccountRole.READONLY,
    })),
    data,
  };
  const message = appendTransactionMessageInstruction(
    instruction,
    setTransactionMessageLifetimeUsingBlockhash(
      lifetime,
      setTransactionMessageFeePayer(owner.address, createTransactionMessage({ version: 0 }))
    )
  );
  return {
    vault,
    owner: owner.address,
    feePayer: owner.address,
    depositMint: usdc,
    atoms,
    canonicalAmount: mode === "cancel" ? "0" : "1",
    mode,
    originalComposer: composer,
    transactionBase64: Buffer.from(
      getTransactionEncoder().encode(compileTransaction(message))
    ).toString("base64"),
  };
}

describe("Plume redemption admission", () => {
  it.each(["standard", "instant", "cancel"] as const)(
    "admits the exact %s route without inventing an atomic settlement",
    async (mode) => {
      const input = await redemptionFixture(mode),
        plan = await admitPlumeTransaction(rpc(), input);
      expect(plan.accepted).toEqual({
        shares: mode === "cancel" ? "0" : "1",
        redemptionMode: mode === "cancel" ? undefined : mode,
      });
      expect(plan.providerTransaction).toBeUndefined();
      await assertFireblocksProposal(plan, input.owner);
    }
  );
  it("rejects an altered redemption payout receiver", async () => {
    await expect(
      admitPlumeTransaction(rpc(), await redemptionFixture("standard", true))
    ).rejects.toThrow("receiver or mode");
  });
  it("rejects cancellation through a composer other than the original order's", async () => {
    const input = await redemptionFixture("cancel");
    await expect(
      admitPlumeTransaction(rpc(), { ...input, originalComposer: vault.redemptionComposer })
    ).rejects.toThrow("route");
  });
});
