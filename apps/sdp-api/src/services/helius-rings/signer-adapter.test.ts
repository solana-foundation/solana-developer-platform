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
import type { TransactionPartialSigner } from "@solana/signers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsOuterTransaction } from "./signer-adapter";

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
      findActiveWalletByPublicKey.mockResolvedValue({ id: "cw_owner", publicKey: FEE_PAYER });
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
      findActiveWalletByPublicKey.mockResolvedValue({ id: "cw_stale", publicKey: FEE_PAYER });
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

    it("maps a custody resolution failure through the signer's retry classification", async () => {
      findActiveWalletByPublicKey.mockResolvedValue({ id: "cw_owner", publicKey: FEE_PAYER });
      createOrgSignerForCustodyWallet.mockRejectedValue(
        new SigningError("provider not set up", "PROVIDER_NOT_CONFIGURED")
      );

      const error = await rejection(signRingsOuterTransaction(signInput()));

      expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
    });
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
