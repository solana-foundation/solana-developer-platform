import { describe, expect, it } from "vitest";
import { createTransferSchema, PAYMENT_TOKEN_VALIDATION_MESSAGE } from "./schemas";

// biome-ignore lint/security/noSecrets: Solana native SOL mint address constant, not a secret.
const SOL_MINT = "So11111111111111111111111111111111111111112";
// biome-ignore lint/security/noSecrets: USDC mint address, not a secret.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const tokenSchema = createTransferSchema.shape.token;

describe("payments token schema", () => {
  describe("accepts native SOL keyword", () => {
    it("'SOL' parses to 'SOL'", () => {
      expect(tokenSchema.parse("SOL")).toBe("SOL");
    });

    it("'sol' is case-folded to 'SOL'", () => {
      expect(tokenSchema.parse("sol")).toBe("SOL");
    });

    it("' SOL ' is trimmed to 'SOL'", () => {
      expect(tokenSchema.parse(" SOL ")).toBe("SOL");
    });

    it("' soL ' combines case + whitespace", () => {
      expect(tokenSchema.parse(" soL ")).toBe("SOL");
    });
  });

  describe("accepts the canonical SOL mint", () => {
    it("parses the bare mint unchanged", () => {
      expect(tokenSchema.parse(SOL_MINT)).toBe(SOL_MINT);
    });

    it("trims whitespace around the mint", () => {
      expect(tokenSchema.parse(` ${SOL_MINT} `)).toBe(SOL_MINT);
    });
  });

  describe("accepts a valid base58 mint", () => {
    it("parses a real USDC mint unchanged", () => {
      expect(tokenSchema.parse(USDC_MINT)).toBe(USDC_MINT);
    });

    it("trims whitespace around a valid mint", () => {
      expect(tokenSchema.parse(` ${USDC_MINT} `)).toBe(USDC_MINT);
    });
  });

  describe("rejects string inputs that do not match the contract", () => {
    const cases: Array<[string, string]> = [
      ["empty string", ""],
      ["token symbol 'USDC'", "USDC"],
      ["token symbol 'BTC'", "BTC"],
      ["too-short non-SOL string", "x".repeat(20)],
      ["too-long string", "x".repeat(50)],
      ["right-length non-base58 string", "!".repeat(43)],
      ["right-length string with non-base58 character (0)", `0${"1".repeat(42)}`],
    ];

    for (const [label, input] of cases) {
      it(`rejects ${label} with the canonical message`, () => {
        const result = tokenSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) {
          const messages = result.error.issues.map((issue) => issue.message);
          expect(messages).toContain(PAYMENT_TOKEN_VALIDATION_MESSAGE);
        }
      });
    }
  });

  describe("rejects non-string inputs", () => {
    const cases: Array<[string, unknown]> = [
      ["number", 123],
      ["null", null],
      ["undefined", undefined],
      ["object", { mint: SOL_MINT }],
    ];

    for (const [label, input] of cases) {
      it(`rejects ${label}`, () => {
        const result = tokenSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
