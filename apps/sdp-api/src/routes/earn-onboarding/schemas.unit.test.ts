import { describe, expect, it } from "vitest";
import {
  EARN_ONBOARDING_MAX_FILE_BYTES,
  onboardingUploadSchema,
  onboardingWalletSchema,
} from "./schemas";

describe("onboarding document upload schema", () => {
  const maxEncodedLength = 4 * Math.ceil(EARN_ONBOARDING_MAX_FILE_BYTES / 3);
  const upload = (contentBase64: string) => ({
    documentType: "formation_document",
    filename: "formation.pdf",
    contentType: "application/pdf",
    contentBase64,
  });

  it("accepts a maximum-size padded document without overflowing the stack", () => {
    // A 20 MiB document encodes to exactly the ceiling; the previous repeated
    // group regex threw RangeError before any size rule could reject it.
    const maxEncoded = Buffer.alloc(EARN_ONBOARDING_MAX_FILE_BYTES).toString("base64");
    expect(maxEncoded.length).toBe(maxEncodedLength);
    expect(onboardingUploadSchema.safeParse(upload(maxEncoded)).success).toBe(true);
  });

  it("rejects an encoded document above the maximum size", () => {
    const oneCharOver = "A".repeat(maxEncodedLength + 1);
    expect(onboardingUploadSchema.safeParse(upload(oneCharOver)).success).toBe(false);
  });

  it("keeps standard padding rules on the trailing group", () => {
    for (const contentBase64 of ["QUJD", "QUI=", "QQ==", "QUJDRA=="]) {
      expect(onboardingUploadSchema.safeParse(upload(contentBase64)).success).toBe(true);
    }
    for (const contentBase64 of ["QUJDRA", "QUJ=DA", "QUJD=", "=QUJ", "QU!D"]) {
      expect(onboardingUploadSchema.safeParse(upload(contentBase64)).success).toBe(false);
    }
  });
});

describe("wallet registration schema", () => {
  const wallet = {
    owner: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    signature: "1".repeat(87),
  };

  it("requires a signature next to the owner address", () => {
    expect(onboardingWalletSchema.safeParse(wallet).success).toBe(true);
    expect(onboardingWalletSchema.safeParse({ owner: wallet.owner }).success).toBe(false);
  });

  it("bounds the signature to the base58 encoding of 64 signature bytes", () => {
    expect(onboardingWalletSchema.safeParse({ ...wallet, signature: "1".repeat(88) }).success).toBe(
      true
    );
    expect(onboardingWalletSchema.safeParse({ ...wallet, signature: "1".repeat(89) }).success).toBe(
      false
    );
  });
});
