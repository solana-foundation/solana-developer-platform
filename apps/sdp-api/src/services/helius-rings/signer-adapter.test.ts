import { SigningError } from "@sdp/custody/signing";
import type { SolanaRpc } from "@sdp/rpc/solana";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getBase64Codec,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  type SignatureBytes,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  createSignableMessage,
  type MessagePartialSigner,
  type TransactionPartialSigner,
} from "@solana/signers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsMessage, signRingsOuterTransaction } from "./signer-adapter";

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const OTHER_KEY = "22222222222222222222222222222222" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;

const base64 = getBase64Codec();
const env = {} as Env;

// Only the resolution path uses these; a test that passes `signer` does not.
const findActiveWalletByPublicKey = vi.hoisted(() => vi.fn());
const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());

vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/services/stores/custody-config.store", () => ({
  CustodyConfigStore: class {
    findActiveWalletByPublicKey = findActiveWalletByPublicKey;
  },
}));
vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));

function unsignedTxBase64(): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(FEE_PAYER, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        current
      )
  );
  return base64.decode(getTransactionEncoder().encode(compileTransaction(message)));
}

/**
 * A signer that can sign raw messages, which `partialSigner` deliberately
 * cannot. `signRingsMessage` is the load-bearing path for every Rings operation
 * now that the shielded keys derive from a custody signature, not just for the
 * ring auditor attestation.
 */
function messageSigner(
  signature: Uint8Array = new Uint8Array(64).fill(3),
  address: Address = FEE_PAYER
): MessagePartialSigner {
  return {
    address,
    signMessages: async () => [{ [address]: signature as SignatureBytes }],
  };
}

function partialSigner(
  sign: () => Promise<Array<Record<Address, SignatureBytes>>>,
  address: Address = FEE_PAYER
): TransactionPartialSigner {
  return { address, signTransactions: sign };
}

function signInput(overrides: Partial<Parameters<typeof signRingsOuterTransaction>[0]> = {}) {
  return {
    env,
    organizationId: "org_1",
    projectId: "prj_1",
    owner: FEE_PAYER as string,
    unsignedTxBase64: unsignedTxBase64(),
    ...overrides,
  };
}

function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => null,
    (thrown: unknown) => thrown
  );
}

describe("signRingsOuterTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attaches the custody signature and returns base64 wire bytes", async () => {
    const signature = new Uint8Array(64).fill(7) as SignatureBytes;
    const signer = partialSigner(async () => [{ [FEE_PAYER]: signature }]);

    const signed = await signRingsOuterTransaction(signInput({ signer }));

    const decoded = getTransactionDecoder().decode(base64.encode(signed));
    expect(decoded.signatures[FEE_PAYER]).toEqual(signature);
  });

  it("maps a transient signer error to a retryable signer_failed", async () => {
    const signer = partialSigner(async () => {
      throw new SigningError("provider timeout", "NETWORK_ERROR");
    });

    const error = await rejection(signRingsOuterTransaction(signInput({ signer })));

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: true });
  });

  it("marks a missing wallet as non-retryable", async () => {
    const signer = partialSigner(async () => {
      throw new SigningError("no such wallet", "WALLET_NOT_FOUND");
    });

    const error = await rejection(signRingsOuterTransaction(signInput({ signer })));

    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
  });

  describe("resolving the owner's custody wallet", () => {
    it("signs through the custody row that holds the owner's key", async () => {
      const signature = new Uint8Array(64).fill(3) as SignatureBytes;
      findActiveWalletByPublicKey.mockResolvedValue({
        id: "cw_owner",
        publicKey: FEE_PAYER,
        provider: "turnkey",
      });
      createOrgSignerForCustodyWallet.mockResolvedValue(
        partialSigner(async () => [{ [FEE_PAYER]: signature }])
      );

      const signed = await signRingsOuterTransaction(signInput());

      // Looked up by key: a signature is only valid from the key the
      // transaction names.
      expect(findActiveWalletByPublicKey).toHaveBeenCalledWith("org_1", "prj_1", FEE_PAYER);
      expect(createOrgSignerForCustodyWallet).toHaveBeenCalledWith(
        env,
        "org_1",
        "prj_1",
        "cw_owner"
      );
      expect(getTransactionDecoder().decode(base64.encode(signed)).signatures[FEE_PAYER]).toEqual(
        signature
      );
    });

    // Never the organization's default wallet: a valid signature from the wrong
    // key moves the wrong money.
    it("refuses an owner custody does not control", async () => {
      findActiveWalletByPublicKey.mockResolvedValue(null);

      const error = await rejection(signRingsOuterTransaction(signInput({ owner: OTHER_KEY })));

      expect(error).toBeInstanceOf(RingsAdapterError);
      expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
      expect((error as Error).message).toContain(OTHER_KEY);
      expect(createOrgSignerForCustodyWallet).not.toHaveBeenCalled();
    });

    // The custody row and its provider have diverged.
    it("refuses when the resolved signer holds a different key", async () => {
      findActiveWalletByPublicKey.mockResolvedValue({
        id: "cw_stale",
        publicKey: FEE_PAYER,
        provider: "turnkey",
      });
      createOrgSignerForCustodyWallet.mockResolvedValue(
        partialSigner(
          async () => [{ [OTHER_KEY]: new Uint8Array(64) as SignatureBytes }],
          OTHER_KEY
        )
      );

      const error = await rejection(signRingsOuterTransaction(signInput()));

      expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
      expect((error as Error).message).toContain("cw_stale");
    });

    /**
     * Structural type guards are not capability guards: `utila` has a
     * `signMessages` that throws, so it satisfies `isMessagePartialSigner` and
     * would surface as a *retryable* failure and retry forever. `coinbase_cdp`
     * UTF-8-decodes the payload, and the derivation envelope starts with 0xff.
     */
    it.each(["coinbase_cdp", "utila", "anchorage"])(
      "refuses %s, which cannot sign raw messages",
      async (provider) => {
        findActiveWalletByPublicKey.mockResolvedValue({
          id: "cw_owner",
          publicKey: FEE_PAYER,
          provider,
        });

        const error = await rejection(signRingsOuterTransaction(signInput()));

        // Non-retryable: no retry teaches a provider to sign raw bytes.
        expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
        expect((error as Error).message).toContain(provider);
        expect(createOrgSignerForCustodyWallet).not.toHaveBeenCalled();
      }
    );

    it("maps a custody resolution failure through the signer's retry classification", async () => {
      findActiveWalletByPublicKey.mockResolvedValue({
        id: "cw_owner",
        publicKey: FEE_PAYER,
        provider: "turnkey",
      });
      createOrgSignerForCustodyWallet.mockRejectedValue(
        new SigningError("provider not set up", "PROVIDER_NOT_CONFIGURED")
      );

      const error = await rejection(signRingsOuterTransaction(signInput()));

      expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
    });
  });
});

/**
 * `signRingsMessage` roots the shielded keys: the owner's signature over
 * Zolana's derivation message is the seed they expand from. It was previously
 * only reachable through ring bring-up and untested.
 */
describe("signRingsMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function messageInput(overrides: Partial<Parameters<typeof signRingsMessage>[0]> = {}) {
    return {
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      owner: FEE_PAYER as string,
      messageBase64: base64.decode(new Uint8Array([1, 2, 3])),
      ...overrides,
    };
  }

  it("returns the signature for the named owner, base64 encoded", async () => {
    const signature = new Uint8Array(64).fill(5);

    const result = await signRingsMessage(
      messageInput({ signer: messageSigner(signature) as never })
    );

    expect(result).toBe(base64.decode(signature));
  });

  it("hands the signer the exact bytes it was given", async () => {
    const message = new Uint8Array([9, 8, 7, 0xff]);
    const signMessages = vi.fn(async () => [{ [FEE_PAYER]: new Uint8Array(64) as SignatureBytes }]);

    await signRingsMessage(
      messageInput({
        messageBase64: base64.decode(message),
        signer: { address: FEE_PAYER, signMessages } as never,
      })
    );

    // Byte-exact: the derivation seed is a signature over one specific 99-byte
    // envelope, and any mangling would derive a different, silently wrong identity.
    expect(signMessages).toHaveBeenCalledWith([createSignableMessage(message)]);
  });

  it("refuses a signer that cannot sign raw messages", async () => {
    const error = await rejection(
      signRingsMessage(messageInput({ signer: partialSigner(async () => [{}]) as never }))
    );

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
  });

  it("refuses when the signer returns nothing for the named owner", async () => {
    // A dictionary keyed by someone else: signing "succeeded" but produced no
    // signature this owner can use, which must not read as success.
    const signer = {
      address: FEE_PAYER,
      signMessages: async () => [{ [OTHER_KEY]: new Uint8Array(64) as SignatureBytes }],
    };

    const error = await rejection(signRingsMessage(messageInput({ signer: signer as never })));

    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
  });

  it("refuses a provider that cannot sign raw messages", async () => {
    findActiveWalletByPublicKey.mockResolvedValue({
      id: "cw_owner",
      publicKey: FEE_PAYER,
      provider: "coinbase_cdp",
    });

    const error = await rejection(signRingsMessage(messageInput()));

    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
  });
});

describe("submitRingsOuterTransaction", () => {
  it("broadcasts and returns the signature", async () => {
    const rpc = {
      sendTransaction: () => ({ send: async () => "sig_abc" }),
    } as unknown as SolanaRpc;

    await expect(
      submitRingsOuterTransaction({ env, signedTxBase64: unsignedTxBase64(), rpc })
    ).resolves.toBe("sig_abc");
  });

  it("maps a broadcast failure to a retryable submit_failed", async () => {
    const rpc = {
      sendTransaction: () => ({
        send: async () => {
          throw new Error("blockhash not found");
        },
      }),
    } as unknown as SolanaRpc;

    const error = await rejection(
      submitRingsOuterTransaction({ env, signedTxBase64: unsignedTxBase64(), rpc })
    );

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect(error).toMatchObject({
      failureCode: "submit_failed",
      retryable: true,
      message: "blockhash not found",
    });
  });
});
