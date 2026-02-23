import { extractSignatureFromWireTransaction } from "@solana/keychain-core";
import { createSignableMessage } from "@solana/signers";
import { getBase64EncodedWireTransaction } from "@solana/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParaSigner } from "../para-signer.js";

vi.mock("@solana/keychain-core", async () => {
  const actual = await vi.importActual<typeof import("@solana/keychain-core")>(
    "@solana/keychain-core"
  );

  return {
    ...actual,
    extractSignatureFromWireTransaction: vi.fn(() => ({
      "11111111111111111111111111111111": Uint8Array.from([9, 9, 9]),
    })),
  };
});

vi.mock("@solana/transactions", async () => {
  const actual = await vi.importActual<typeof import("@solana/transactions")>(
    "@solana/transactions"
  );

  return {
    ...actual,
    getBase64EncodedWireTransaction: vi.fn(() => "AQAB"),
  };
});

describe("ParaSigner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails create() when required config is missing", async () => {
    await expect(
      ParaSigner.create({
        apiKey: "",
        walletId: "",
      })
    ).rejects.toThrowError(/missing required configuration fields/i);
  });

  it("parses hex signature responses into signature bytes when signing messages", async () => {
    const walletAddress = "11111111111111111111111111111111";
    const expectedSignatureBytes = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
    const signatureHex = Array.from(expectedSignatureBytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/v1/wallets/wal_123") && init?.method === "GET") {
          return new Response(
            JSON.stringify({
              id: "wal_123",
              type: "SOLANA",
              scheme: "ED25519",
              status: "ready",
              address: walletAddress,
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }
          );
        }

        if (url.endsWith("/v1/wallets/wal_123/sign-raw") && init?.method === "POST") {
          return new Response(JSON.stringify({ signature: `0x${signatureHex}` }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    try {
      const signer = await ParaSigner.create({
        apiKey: "para_api_key",
        walletId: "wal_123",
      });

      const [signatureDictionary] = await signer.signMessages([
        createSignableMessage(Uint8Array.from([1, 2, 3])),
      ]);

      expect(Object.keys(signatureDictionary)).toContain(walletAddress);
      const actualSignature = Object.values(signatureDictionary)[0] as Uint8Array | undefined;
      expect(actualSignature).toBeDefined();
      expect(Array.from(actualSignature ?? [])).toEqual(Array.from(expectedSignatureBytes));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uses signed transaction response and extracts signer signature dictionary", async () => {
    const walletAddress = "11111111111111111111111111111111";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/v1/wallets/wal_123") && init?.method === "GET") {
          return new Response(
            JSON.stringify({
              id: "wal_123",
              type: "SOLANA",
              scheme: "ED25519",
              status: "ready",
              address: walletAddress,
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }
          );
        }

        if (url.endsWith("/v1/wallets/wal_123/sign-transaction") && init?.method === "POST") {
          return new Response(JSON.stringify({ signedTransaction: "AgICAg==" }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    try {
      const signer = await ParaSigner.create({
        apiKey: "para_api_key",
        walletId: "wal_123",
      });

      const [signatureDictionary] = await signer.signTransactions([
        {} as never,
      ]);

      expect(Object.keys(signatureDictionary)).toContain(walletAddress);
      expect(vi.mocked(getBase64EncodedWireTransaction)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(extractSignatureFromWireTransaction)).toHaveBeenCalledWith({
        base64WireTransaction: "AgICAg==",
        signerAddress: walletAddress,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("falls back to sign-raw when Para rejects sign-transaction payloads", async () => {
    const walletAddress = "11111111111111111111111111111111";
    const expectedSignatureBytes = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
    const signatureHex = Array.from(expectedSignatureBytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/v1/wallets/wal_123") && init?.method === "GET") {
          return new Response(
            JSON.stringify({
              id: "wal_123",
              type: "SOLANA",
              scheme: "ED25519",
              status: "ready",
              address: walletAddress,
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }
          );
        }

        if (url.endsWith("/v1/wallets/wal_123/sign-transaction") && init?.method === "POST") {
          return new Response(JSON.stringify({ message: "invalid transaction payload" }), {
            headers: { "Content-Type": "application/json" },
            status: 400,
          });
        }

        if (url.endsWith("/v1/wallets/wal_123/sign-raw") && init?.method === "POST") {
          return new Response(JSON.stringify({ signature: `0x${signatureHex}` }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    try {
      const signer = await ParaSigner.create({
        apiKey: "para_api_key",
        walletId: "wal_123",
      });

      const [signatureDictionary] = await signer.signTransactions([
        {
          messageBytes: Uint8Array.from([1, 2, 3]),
        } as never,
      ]);

      expect(Object.keys(signatureDictionary)).toContain(walletAddress);
      const actualSignature = Object.values(signatureDictionary)[0] as Uint8Array | undefined;
      expect(actualSignature).toBeDefined();
      expect(Array.from(actualSignature ?? [])).toEqual(Array.from(expectedSignatureBytes));
      expect(vi.mocked(extractSignatureFromWireTransaction)).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects non-ready wallets during create", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "wal_123",
          type: "SOLANA",
          scheme: "ED25519",
          status: "creating",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      )
    );

    await expect(
      ParaSigner.create({
        apiKey: "para_api_key",
        walletId: "wal_123",
      })
    ).rejects.toThrowError(/not ready/i);

    fetchMock.mockRestore();
  });

  it("propagates non-200 API errors from Para", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/v1/wallets/wal_123") && init?.method === "GET") {
          return new Response(
            JSON.stringify({
              id: "wal_123",
              type: "SOLANA",
              scheme: "ED25519",
              status: "ready",
              address: "11111111111111111111111111111111",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }
          );
        }

        if (url.endsWith("/v1/wallets/wal_123/sign-raw") && init?.method === "POST") {
          return new Response(JSON.stringify({ error: "internal_error" }), {
            headers: { "Content-Type": "application/json" },
            status: 500,
          });
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    try {
      const signer = await ParaSigner.create({
        apiKey: "para_api_key",
        walletId: "wal_123",
      });

      await expect(
        signer.signMessages([createSignableMessage(Uint8Array.from([1, 2, 3]))])
      ).rejects.toThrowError(/Para API error: 500 - .*internal_error/i);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects malformed sign-transaction responses", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.endsWith("/v1/wallets/wal_123") && init?.method === "GET") {
          return new Response(
            JSON.stringify({
              id: "wal_123",
              type: "SOLANA",
              scheme: "ED25519",
              status: "ready",
              address: "11111111111111111111111111111111",
            }),
            {
              headers: { "Content-Type": "application/json" },
              status: 200,
            }
          );
        }

        if (url.endsWith("/v1/wallets/wal_123/sign-transaction") && init?.method === "POST") {
          return new Response(JSON.stringify({ notSignedTransaction: "AgICAg==" }), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          });
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    try {
      const signer = await ParaSigner.create({
        apiKey: "para_api_key",
        walletId: "wal_123",
      });

      await expect(signer.signTransactions([{} as never])).rejects.toThrowError(
        /Missing signed transaction/i
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
});
