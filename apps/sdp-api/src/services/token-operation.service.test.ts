import { MOSAIC_AMOUNT_REFUSALS, MosaicAmountError } from "@sdp/solana/mosaic-amount";
import { parseTokenAmount } from "@sdp/solana/token-amount";
import { TOKEN_TERMS_REFUSALS, TokenTermsError } from "@sdp/solana/token-terms";
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  assertTokenAllowsOperation,
  parsePositiveTokenAmount,
  resolveMintOperationAmount,
  withLiveIssuanceTerms,
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
        amount: parseTokenAmount("1.25", 2),
        amountBaseUnits: BigInt(125),
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
        amount: parseTokenAmount("2.5", mintableToken.decimals),
        amountBaseUnits: BigInt(250),
        mintAddress: mintableToken.mintAddress,
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

  describe("withLiveIssuanceTerms", () => {
    const refusedWith = (error: Error) =>
      withLiveIssuanceTerms(() => Promise.reject(error)).then(
        () => {
          throw new Error("Expected the call to be refused");
        },
        (cause: unknown) => cause
      );

    it("answers the live mint's refusals as 400s, a paused mint as TOKEN_PAUSED", async () => {
      expect(
        await refusedWith(
          new MosaicAmountError(
            MOSAIC_AMOUNT_REFUSALS.unsupported,
            "This token is paused",
            "paused"
          )
        )
      ).toMatchObject({ code: "TOKEN_PAUSED", statusCode: 400 });
      expect(
        await refusedWith(
          new MosaicAmountError(
            MOSAIC_AMOUNT_REFUSALS.unsupported,
            "This token runs a transfer hook",
            "transfer_hook"
          )
        )
      ).toMatchObject({ code: "BAD_REQUEST", details: { reason: "transfer_hook" } });
      for (const reason of [MOSAIC_AMOUNT_REFUSALS.scaleMismatch, MOSAIC_AMOUNT_REFUSALS.inexact]) {
        expect(await refusedWith(new MosaicAmountError(reason, "no", null))).toMatchObject({
          code: "INVALID_TOKEN_AMOUNT",
        });
      }
      expect(
        await refusedWith(new TokenTermsError(TOKEN_TERMS_REFUSALS.notMint, "No account"))
      ).toMatchObject({ code: "BAD_REQUEST", details: { reason: "not_a_mint" } });
    });

    it("passes every other error through", async () => {
      const failure = new Error("RPC down");
      expect(await refusedWith(failure)).toBe(failure);
    });
  });
});
