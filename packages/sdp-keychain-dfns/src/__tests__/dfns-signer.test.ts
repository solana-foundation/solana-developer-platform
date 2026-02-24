import type { DfnsApiClient } from "../types.js";
import { extractSignatureFromWireTransaction } from "@solana/keychain-core";
import { createSignableMessage } from "@solana/signers";
import { getBase64EncodedWireTransaction } from "@solana/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DfnsSigner } from "../dfns-signer.js";

const TEST_WALLET_ADDRESS = "11111111111111111111111111111111";

vi.mock("@solana/keychain-core", async () => {
  const actual =
    await vi.importActual<typeof import("@solana/keychain-core")>("@solana/keychain-core");

  return {
    ...actual,
    extractSignatureFromWireTransaction: vi.fn(() => ({
      [TEST_WALLET_ADDRESS]: Uint8Array.from([9, 9, 9]),
    })),
  };
});

vi.mock("@solana/transactions", async () => {
  const actual =
    await vi.importActual<typeof import("@solana/transactions")>("@solana/transactions");

  return {
    ...actual,
    getBase64EncodedWireTransaction: vi.fn(() => "AQAB"),
  };
});

describe("DfnsSigner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails create() when required config is missing", async () => {
    await expect(
      DfnsSigner.create({
        client: undefined as unknown as DfnsApiClient,
        walletId: "",
      })
    ).rejects.toThrowError(/missing required configuration fields/i);
  });

  it("loads wallet address from getWallet", async () => {
    const getWallet = vi.fn().mockResolvedValue({
      id: "wa_test",
      address: TEST_WALLET_ADDRESS,
      signingKey: { id: "key_test" },
    });

    const signer = await DfnsSigner.create({
      client: createMockDfnsClient({ getWallet }),
      walletId: "wa_test",
    });

    expect(signer.address).toBe(TEST_WALLET_ADDRESS);
    expect(getWallet).toHaveBeenCalledWith({ walletId: "wa_test" });
  });

  it("denormalizes `dfns_` wallet IDs", async () => {
    const getWallet = vi.fn().mockResolvedValue({
      id: "wa_test",
      address: TEST_WALLET_ADDRESS,
      signingKey: { id: "key_test" },
    });

    await DfnsSigner.create({
      client: createMockDfnsClient({ getWallet }),
      walletId: "dfns_wa_test",
    });

    expect(getWallet).toHaveBeenCalledWith({ walletId: "wa_test" });
  });

  it("parses signedData hex into signature bytes when signing messages", async () => {
    const expectedSignature = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
    const createSignature = vi.fn().mockResolvedValue({
      id: "sig_test",
      status: "Signed",
      signedData: toHex(expectedSignature),
    });

    const signer = await DfnsSigner.create({
      client: createMockDfnsClient({
        getWallet: vi.fn().mockResolvedValue({
          id: "wa_test",
          network: "SolanaDevnet",
          address: TEST_WALLET_ADDRESS,
          signingKey: { id: "key_test" },
        }),
        createSignature,
      }),
      walletId: "wa_test",
    });

    const [signatureDictionary] = await signer.signMessages([
      createSignableMessage(Uint8Array.from([1, 2, 3])),
    ]);

    expect(Object.keys(signatureDictionary)).toContain(TEST_WALLET_ADDRESS);
    const actualSignature = Object.values(signatureDictionary)[0] as Uint8Array | undefined;
    expect(actualSignature).toBeDefined();
    expect(Array.from(actualSignature ?? [])).toEqual(Array.from(expectedSignature));
    expect(createSignature).toHaveBeenCalledWith({
      keyId: "key_test",
      body: {
        kind: "Message",
        message: "0x010203",
        network: "SolanaDevnet",
      },
    });
  });

  it("signs transactions and forwards signed wire data for signature extraction", async () => {
    const createSignature = vi.fn().mockResolvedValue({
      id: "sig_test_tx",
      status: "Signed",
      signedData: "0x020202",
    });

    const signer = await DfnsSigner.create({
      client: createMockDfnsClient({
        getWallet: vi.fn().mockResolvedValue({
          id: "wa_test",
          network: "SolanaDevnet",
          address: TEST_WALLET_ADDRESS,
          signingKey: { id: "key_test" },
        }),
        createSignature,
      }),
      walletId: "wa_test",
    });

    const [signatureDictionary] = await signer.signTransactions([{} as never]);

    expect(Object.keys(signatureDictionary)).toContain(TEST_WALLET_ADDRESS);
    expect(vi.mocked(getBase64EncodedWireTransaction)).toHaveBeenCalledTimes(1);
    expect(createSignature).toHaveBeenCalledWith({
      keyId: "key_test",
      body: {
        kind: "Transaction",
        transaction: "0x010001",
        network: "SolanaDevnet",
      },
    });
    expect(vi.mocked(extractSignatureFromWireTransaction)).toHaveBeenCalledWith({
      base64WireTransaction: "AgIC",
      signerAddress: TEST_WALLET_ADDRESS,
    });
  });

  it("polls signature status when DFNS returns pending", async () => {
    const createSignature = vi.fn().mockResolvedValue({
      id: "sig_pending",
      status: "Pending",
    });
    const getSignature = vi.fn().mockResolvedValue({
      id: "sig_pending",
      status: "Signed",
      signedData: toHex(Uint8Array.from({ length: 64 }, (_, index) => index + 1)),
    });

    const signer = await DfnsSigner.create({
      client: createMockDfnsClient({
        getWallet: vi.fn().mockResolvedValue({
          id: "wa_test",
          network: "SolanaDevnet",
          address: TEST_WALLET_ADDRESS,
          signingKey: { id: "key_test" },
        }),
        createSignature,
        getSignature,
      }),
      walletId: "wa_test",
    });

    await signer.signMessages([createSignableMessage(Uint8Array.from([7]))]);

    expect(getSignature).toHaveBeenCalledWith({
      keyId: "key_test",
      signatureId: "sig_pending",
    });
  });

  it("falls back to blockchain kind when wallet network is missing", async () => {
    const createSignature = vi.fn().mockResolvedValue({
      id: "sig_test",
      status: "Signed",
      signedData: toHex(Uint8Array.from({ length: 64 }, (_, index) => index + 1)),
    });

    const signer = await DfnsSigner.create({
      client: createMockDfnsClient({
        getWallet: vi.fn().mockResolvedValue({
          id: "wa_test",
          address: TEST_WALLET_ADDRESS,
          signingKey: { id: "key_test" },
        }),
        createSignature,
      }),
      walletId: "wa_test",
    });

    await signer.signMessages([createSignableMessage(Uint8Array.from([7, 8]))]);

    expect(createSignature).toHaveBeenCalledWith({
      keyId: "key_test",
      body: {
        kind: "Message",
        message: "0x0708",
        blockchainKind: "Solana",
      },
    });
  });

  it("throws when DFNS rejects a signature request", async () => {
    const signer = await DfnsSigner.create({
      client: createMockDfnsClient({
        getWallet: vi.fn().mockResolvedValue({
          id: "wa_test",
          network: "SolanaDevnet",
          address: TEST_WALLET_ADDRESS,
          signingKey: { id: "key_test" },
        }),
        createSignature: vi.fn().mockResolvedValue({
          id: "sig_failed",
          status: "Failed",
          reason: "policy denied",
        }),
      }),
      walletId: "wa_test",
    });

    await expect(signer.signMessages([createSignableMessage(Uint8Array.from([9]))])).rejects.toThrow(
      /policy denied/i
    );
  });
});

function createMockDfnsClient(params: {
  getWallet?: ReturnType<typeof vi.fn>;
  createSignature?: ReturnType<typeof vi.fn>;
  getSignature?: ReturnType<typeof vi.fn>;
}): DfnsApiClient {
  return {
    wallets: {
      getWallet:
        params.getWallet ??
        vi.fn().mockResolvedValue({
          id: "wa_test",
          network: "SolanaDevnet",
          address: TEST_WALLET_ADDRESS,
          signingKey: { id: "key_test" },
        }),
    },
    keySignatures: {
      createSignature:
        params.createSignature ??
        vi.fn().mockResolvedValue({
          id: "sig_test",
          status: "Signed",
          signedData: toHex(Uint8Array.from({ length: 64 }, (_, index) => index + 1)),
        }),
      getSignature:
        params.getSignature ??
        vi.fn().mockResolvedValue({
          id: "sig_test",
          status: "Signed",
          signedData: toHex(Uint8Array.from({ length: 64 }, (_, index) => index + 1)),
        }),
    },
  };
}

function toHex(value: Uint8Array): string {
  return `0x${Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
