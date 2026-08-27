import { SigningError } from "@sdp/custody/signing";
import type { SolanaRpc } from "@sdp/rpc/solana";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createKeyPairFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressFromPublicKey,
  getBase58Codec,
  getBase64Codec,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  type SignatureBytes,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
} from "@solana/kit";
import type { TransactionPartialSigner } from "@solana/signers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { assertRingsSignedTransactionMatches, signRingsOuterTransaction } from "./signer-adapter";

vi.mock("@/db", () => ({ getDb: () => ({}) }));

const { createOrgSignerForCustodyWallet } = vi.hoisted(() => ({
  createOrgSignerForCustodyWallet: vi.fn(),
}));
vi.mock("@/services/solana/signer", () => ({ createOrgSignerForCustodyWallet }));

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;

const base64 = getBase64Codec();
const env = {} as Env;

function unsignedTxBase64For(feePayer: Address, blockhash = BLOCKHASH): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(feePayer, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash, lastValidBlockHeight: 100n },
        current
      )
  );
  return base64.decode(getTransactionEncoder().encode(compileTransaction(message)));
}

function unsignedTxBase64(blockhash = BLOCKHASH): string {
  return unsignedTxBase64For(FEE_PAYER, blockhash);
}

function partialSigner(
  sign: () => Promise<Array<Record<Address, SignatureBytes>>>
): TransactionPartialSigner {
  return { address: FEE_PAYER, signTransactions: sign };
}

function signedTxBase64(
  unsigned = unsignedTxBase64(),
  signatures: Record<Address, SignatureBytes | null> = {
    [FEE_PAYER]: new Uint8Array(64).fill(7) as SignatureBytes,
  }
): string {
  const transaction = getTransactionDecoder().decode(base64.encode(unsigned));
  return base64.decode(getTransactionEncoder().encode({ ...transaction, signatures }));
}

const OWNER_KEYPAIR = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(41));
const OTHER_KEYPAIR = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(42));
const OWNER = await getAddressFromPublicKey(OWNER_KEYPAIR.publicKey);
const OTHER = await getAddressFromPublicKey(OTHER_KEYPAIR.publicKey);

async function cryptographicallySignedTxBase64(
  unsigned = unsignedTxBase64(),
  privateKey: CryptoKey = OWNER_KEYPAIR.privateKey
): Promise<string> {
  const transaction = getTransactionDecoder().decode(base64.encode(unsigned));
  const signature = await signBytes(privateKey, transaction.messageBytes);
  return signedTxBase64(unsigned, { [OWNER]: signature });
}

/**
 * Which key signs, when the caller does not hand one in.
 *
 * Rings registers an identity to an owner and spends from it, so the signature
 * has to come from that owner rather than from whichever wallet the
 * organization's custody config happens to default to.
 */
describe("signRingsOuterTransaction owner resolution", () => {
  const walletByPublicKey = vi.spyOn(CustodyConfigStore.prototype, "findActiveWalletByPublicKey");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signs with the custody wallet holding the owner's key", async () => {
    walletByPublicKey.mockResolvedValue({ id: "cw_owner", publicKey: FEE_PAYER } as never);
    createOrgSignerForCustodyWallet.mockResolvedValue(
      partialSigner(async () => [{ [FEE_PAYER]: new Uint8Array(64).fill(3) as SignatureBytes }])
    );

    await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      owner: FEE_PAYER,
      unsignedTxBase64: unsignedTxBase64(),
    });

    expect(walletByPublicKey).toHaveBeenCalledWith("org_1", "prj_1", FEE_PAYER);
    // The row id, which is what resolves a signer; the provider's own wallet id
    // is not unique across retained project and organization targets.
    expect(createOrgSignerForCustodyWallet).toHaveBeenCalledWith(env, "org_1", "prj_1", "cw_owner");
  });

  it("refuses to sign for an owner custody does not control", async () => {
    walletByPublicKey.mockResolvedValue(null);

    const error = await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      owner: FEE_PAYER,
      unsignedTxBase64: unsignedTxBase64(),
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    // Non-retryable: no amount of retrying makes custody hold a key it does
    // not have, and falling back to the default signer would produce a
    // signature for a wallet nobody named.
    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
    expect(createOrgSignerForCustodyWallet).not.toHaveBeenCalled();
  });

  it("stops when custody resolves a different key than the owner", async () => {
    walletByPublicKey.mockResolvedValue({ id: "cw_owner", publicKey: FEE_PAYER } as never);
    createOrgSignerForCustodyWallet.mockResolvedValue({
      address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      signTransactions: async () => [],
    });

    const error = await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      owner: FEE_PAYER,
      unsignedTxBase64: unsignedTxBase64(),
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
  });
});

describe("signRingsOuterTransaction", () => {
  it("attaches the custody signature and returns base64 wire bytes", async () => {
    const signature = new Uint8Array(64).fill(7) as SignatureBytes;
    const signer = partialSigner(async () => [{ [FEE_PAYER]: signature }]);

    const signed = await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      owner: FEE_PAYER,
      unsignedTxBase64: unsignedTxBase64(),
      signer,
    });

    const decoded = getTransactionDecoder().decode(base64.encode(signed));
    expect(decoded.signatures[FEE_PAYER]).toEqual(signature);
  });

  it("maps a transient signer error to a retryable signer_failed", async () => {
    const signer = partialSigner(async () => {
      throw new SigningError("provider timeout", "NETWORK_ERROR");
    });

    const error = await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      owner: FEE_PAYER,
      unsignedTxBase64: unsignedTxBase64(),
      signer,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: true });
  });

  it("marks a missing wallet as non-retryable", async () => {
    const signer = partialSigner(async () => {
      throw new SigningError("no such wallet", "WALLET_NOT_FOUND");
    });

    const error = await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      owner: FEE_PAYER,
      unsignedTxBase64: unsignedTxBase64(),
      signer,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
  });
});

describe("assertRingsSignedTransactionMatches", () => {
  it("accepts a real owner signature over the exact message bytes", async () => {
    const unsigned = unsignedTxBase64For(OWNER);

    await expect(
      assertRingsSignedTransactionMatches({
        owner: OWNER,
        unsignedTxBase64: unsigned,
        signedTxBase64: await cryptographicallySignedTxBase64(unsigned),
      })
    ).resolves.toEqual(expect.any(String));
  });

  it("rejects the same message with a byte-filled invalid signature", async () => {
    const unsigned = unsignedTxBase64For(OWNER);

    await expect(
      assertRingsSignedTransactionMatches({
        owner: OWNER,
        unsignedTxBase64: unsigned,
        signedTxBase64: signedTxBase64(unsigned, {
          [OWNER]: new Uint8Array(64).fill(7) as SignatureBytes,
        }),
      })
    ).rejects.toMatchObject({ failureCode: "signer_failed", retryable: false });
  });

  it("rejects a missing owner signature", async () => {
    const unsigned = unsignedTxBase64For(OWNER);

    await expect(
      assertRingsSignedTransactionMatches({
        owner: OWNER,
        unsignedTxBase64: unsigned,
        signedTxBase64: unsigned,
      })
    ).rejects.toMatchObject({ failureCode: "signer_failed", retryable: false });
  });

  it("rejects signatures outside the sole owner slot", async () => {
    const unsigned = unsignedTxBase64For(OWNER);
    const messageBytes = getTransactionDecoder().decode(base64.encode(unsigned)).messageBytes;

    await expect(
      assertRingsSignedTransactionMatches({
        owner: OWNER,
        unsignedTxBase64: unsigned,
        signedTxBase64: signedTxBase64(unsigned, {
          [OWNER]: await signBytes(OWNER_KEYPAIR.privateKey, messageBytes),
          [OTHER]: await signBytes(OTHER_KEYPAIR.privateKey, messageBytes),
        }),
      })
    ).rejects.toMatchObject({ failureCode: "signer_failed", retryable: false });
  });

  it("rejects a real signature produced by another key", async () => {
    const unsigned = unsignedTxBase64For(OWNER);

    await expect(
      assertRingsSignedTransactionMatches({
        owner: OWNER,
        unsignedTxBase64: unsigned,
        signedTxBase64: await cryptographicallySignedTxBase64(unsigned, OTHER_KEYPAIR.privateKey),
      })
    ).rejects.toMatchObject({ failureCode: "signer_failed", retryable: false });
  });

  it("rejects a real owner signature over changed message bytes", async () => {
    const unsigned = unsignedTxBase64For(OWNER);
    const changed = unsignedTxBase64For(
      OWNER,
      getBase58Codec().decode(new Uint8Array(32).fill(8)) as Blockhash
    );

    await expect(
      assertRingsSignedTransactionMatches({
        owner: OWNER,
        unsignedTxBase64: unsigned,
        signedTxBase64: await cryptographicallySignedTxBase64(changed),
      })
    ).rejects.toMatchObject({ failureCode: "signer_failed", retryable: false });
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

    const error = await submitRingsOuterTransaction({
      env,
      signedTxBase64: unsignedTxBase64(),
      rpc,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect(error).toMatchObject({
      failureCode: "submit_failed",
      retryable: true,
      message: "blockhash not found",
    });
  });
});
