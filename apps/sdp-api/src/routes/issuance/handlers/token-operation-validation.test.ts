import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  assertTokenAllowsSupplyOperation,
  parsePositiveTokenAmount,
} from "./token-operation-validation";

describe("token-operation-validation", () => {
  describe("assertTokenAllowsSupplyOperation", () => {
    it("allows active tokens", () => {
      expect(() => assertTokenAllowsSupplyOperation({ status: "active" }, "mint")).not.toThrow();
    });

    it("returns TOKEN_PAUSED for paused tokens", () => {
      try {
        assertTokenAllowsSupplyOperation({ status: "paused" }, "burn");
        throw new Error("Expected burn validation to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("TOKEN_PAUSED");
      }
    });

    it("returns TOKEN_NOT_ACTIVE for pending tokens", () => {
      try {
        assertTokenAllowsSupplyOperation({ status: "pending" }, "mint");
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
});
