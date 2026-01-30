/**
 * Token-2022 Utils Unit Tests
 *
 * Tests for pure Token-2022 utility functions.
 * Note: getExtensionTypes depends on @solana-program/token-2022
 * so we test the logic, not the SDK integration.
 */

import {
  addressAsSigner,
  bigIntReplacer,
  getExtensionTypes,
  safeStringify,
} from "@/services/solana/token-2022.utils";
import type { TokenExtensionsConfig } from "@sdp/types";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";

describe("bigIntReplacer", () => {
  it("converts bigint to string", () => {
    expect(bigIntReplacer("slot", 12345n)).toBe("12345");
  });

  it("preserves non-bigint values", () => {
    expect(bigIntReplacer("name", "test")).toBe("test");
    expect(bigIntReplacer("count", 42)).toBe(42);
  });
});

describe("safeStringify", () => {
  it("stringifies objects with bigint values", () => {
    const obj = { slot: 12345n, name: "test" };
    expect(safeStringify(obj)).toBe('{"slot":"12345","name":"test"}');
  });
});

describe("addressAsSigner", () => {
  it("creates a signer-like object from address", () => {
    // biome-ignore lint/nursery/noSecrets: Test Solana address
    const address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
    const signer = addressAsSigner(address);

    expect(signer.address).toBe(address);
  });

  it("returns object that can be used as TransactionSigner", () => {
    // biome-ignore lint/nursery/noSecrets: Test Solana address
    const address = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ" as Address;
    const signer = addressAsSigner(address);

    // Should have the address property required by TransactionSigner
    expect(typeof signer.address).toBe("string");
    expect(signer.address).toHaveLength(44); // Base58 Solana address length
  });
});

// biome-ignore lint/nursery/noSecrets: Function name triggers false positive
describe("getExtensionTypes", () => {
  it("returns empty array for undefined extensions", () => {
    expect(getExtensionTypes(undefined)).toEqual([]);
  });

  it("returns empty array for empty extensions", () => {
    expect(getExtensionTypes({})).toEqual([]);
  });

  it("handles transferFee extension", () => {
    const extensions: TokenExtensionsConfig = {
      transferFee: {
        // biome-ignore lint/nursery/noSecrets: Test Solana address
        transferFeeConfigAuthority: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
        // biome-ignore lint/nursery/noSecrets: Test Solana address
        withdrawWithheldAuthority: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
        basisPoints: 100, // 1%
        maxFee: "1.5",
      },
    };

    const result = getExtensionTypes(extensions, 6);
    expect(result).toHaveLength(1);
    // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
    expect(result[0].__kind).toBe("TransferFeeConfig");
  });

  it("handles permanentDelegate extension", () => {
    const extensions: TokenExtensionsConfig = {
      // biome-ignore lint/nursery/noSecrets: Test Solana address
      permanentDelegate: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
    };

    const result = getExtensionTypes(extensions);
    expect(result).toHaveLength(1);
    // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
    expect(result[0].__kind).toBe("PermanentDelegate");
  });

  it("handles defaultAccountState extension - frozen", () => {
    const extensions: TokenExtensionsConfig = {
      defaultAccountState: "frozen",
    };

    const result = getExtensionTypes(extensions);
    expect(result).toHaveLength(1);
    // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
    expect(result[0].__kind).toBe("DefaultAccountState");
  });

  it("handles defaultAccountState extension - initialized", () => {
    const extensions: TokenExtensionsConfig = {
      defaultAccountState: "initialized",
    };

    const result = getExtensionTypes(extensions);
    expect(result).toHaveLength(1);
    // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
    expect(result[0].__kind).toBe("DefaultAccountState");
  });

  it("handles nonTransferable extension", () => {
    const extensions: TokenExtensionsConfig = {
      nonTransferable: true,
    };

    const result = getExtensionTypes(extensions);
    expect(result).toHaveLength(1);
    expect(result[0].__kind).toBe("NonTransferable");
  });

  it("handles multiple extensions", () => {
    const extensions: TokenExtensionsConfig = {
      // biome-ignore lint/nursery/noSecrets: Test Solana address
      permanentDelegate: "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ",
      defaultAccountState: "frozen",
      nonTransferable: true,
    };

    const result = getExtensionTypes(extensions);
    expect(result).toHaveLength(3);

    const kinds = result.map((ext) => ext.__kind);
    // biome-ignore lint/nursery/noSecrets: Token-2022 extension names, not secrets
    expect(kinds).toContain("PermanentDelegate");
    // biome-ignore lint/nursery/noSecrets: Token-2022 extension names, not secrets
    expect(kinds).toContain("DefaultAccountState");
    expect(kinds).toContain("NonTransferable");
  });

  it("ignores false nonTransferable", () => {
    const extensions: TokenExtensionsConfig = {
      nonTransferable: false,
    };

    const result = getExtensionTypes(extensions);
    expect(result).toEqual([]);
  });
});
