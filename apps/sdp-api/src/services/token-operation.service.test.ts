import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  assertTokenAllowsOperation,
  parsePositiveTokenAmount,
  resolveMintOperationAmount,
} from "./token-operation.service";

describe("token-operation.service", () => {
  describe("assertTokenAllowsOperation", () => {
    it("allows active tokens", () => {
      expect(() =>
        assertTokenAllowsOperation({ status: "active", decimals: 9 }, "mint")
      ).not.toThrow();
    });

    it("returns TOKEN_PAUSED for paused tokens", () => {
      try {
        assertTokenAllowsOperation({ status: "paused", decimals: 9 }, "burn");
        throw new Error("Expected burn validation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("TOKEN_PAUSED");
      }
    });

    it("returns TOKEN_NOT_ACTIVE for pending tokens", () => {
      try {
        assertTokenAllowsOperation({ status: "pending", decimals: 9 }, "mint");
        throw new Error("Expected mint validation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("TOKEN_NOT_ACTIVE");
      }
    });
  });

  describe("parsePositiveTokenAmount", () => {
    it("parses valid decimal amounts", () => {
      expect(parsePositiveTokenAmount("1.25", 2)).toEqual({
        amountBaseUnits: BigInt(125),
        mosaicAmount: 1.25,
      });
    });

    it("returns INVALID_TOKEN_AMOUNT for zero amounts", () => {
      try {
        parsePositiveTokenAmount("0", 6);
        throw new Error("Expected zero amount validation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("INVALID_TOKEN_AMOUNT");
      }
    });

    it("returns INVALID_TOKEN_AMOUNT for amounts that exceed token precision", () => {
      try {
        parsePositiveTokenAmount("1.0000001", 6);
        throw new Error("Expected precision validation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("INVALID_TOKEN_AMOUNT");
      }
    });
  });

  describe("resolveMintOperationAmount", () => {
    const mintableToken = {
      status: "active" as const,
      mintAddress: "So11111111111111111111111111111111111111112",
      isMintable: true,
      totalSupply: "10",
      maxSupply: "20",
      decimals: 2,
    };

    it("returns parsed mint amount with deployed mint address", () => {
      expect(resolveMintOperationAmount(mintableToken, "2.5")).toEqual({
        amountBaseUnits: BigInt(250),
        mintAddress: mintableToken.mintAddress,
        mosaicAmount: 2.5,
      });
    });

    it("returns TOKEN_NOT_MINTABLE for non-mintable tokens", () => {
      try {
        resolveMintOperationAmount({ ...mintableToken, isMintable: false }, "1");
        throw new Error("Expected mintable validation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("TOKEN_NOT_MINTABLE");
      }
    });

    it("returns MAX_SUPPLY_EXCEEDED when minting would exceed max supply", () => {
      try {
        resolveMintOperationAmount(mintableToken, "10.01");
        throw new Error("Expected max supply validation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("MAX_SUPPLY_EXCEEDED");
      }
    });
  });
});
