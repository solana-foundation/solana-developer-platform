import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { assertTokenNotConfidentialMintBurn } from "@/services/issuance/confidential-support";
import type { Env } from "@/types/env";
import { confidentialBalanceQuerySchema } from "../schemas";
import {
  assertTokenSupportsConfidentialMintBurn,
  assertTokenSupportsConfidentialTransfers,
  requireConfidentialTransfersDevnet,
  toConfidentialAppError,
} from "./confidential";

type TokenArg = Parameters<typeof assertTokenSupportsConfidentialTransfers>[0];

const token = (overrides: Partial<TokenArg>): TokenArg =>
  ({ template: "custom", extensions: {}, ...overrides }) as TokenArg;

const contextFor = (network?: string) =>
  ({ env: { SOLANA_NETWORK: network } as unknown as Env }) as Parameters<
    typeof requireConfidentialTransfersDevnet
  >[0];

describe("requireConfidentialTransfersDevnet", () => {
  it("passes through on devnet", async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    await requireConfidentialTransfersDevnet(contextFor("devnet"), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // SOLANA_NETWORK is optional in the env contract, so an unset value must not
  // read as "not devnet" and open the surface by accident — nor close it.
  it("treats an unset network as devnet, matching the rest of the API", async () => {
    const next = vi.fn().mockResolvedValue(undefined);
    await requireConfidentialTransfersDevnet(contextFor(undefined), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("refuses on mainnet without running the handler", async () => {
    const next = vi.fn();
    await expect(
      requireConfidentialTransfersDevnet(contextFor("mainnet-beta"), next)
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(next).not.toHaveBeenCalled();
  });
});

describe("assertTokenSupportsConfidentialTransfers", () => {
  // The stablecoin and tokenized-security templates always initialize the mint
  // with the extension, so their stored config says nothing either way.
  it.each(["stablecoin", "tokenized-security"])("allows the %s template", (template) => {
    expect(() =>
      assertTokenSupportsConfidentialTransfers(token({ template } as Partial<TokenArg>))
    ).not.toThrow();
  });

  it("allows a custom token that configured the extension at creation", () => {
    expect(() =>
      assertTokenSupportsConfidentialTransfers(
        token({ extensions: { confidentialTransfers: { policy: "opt-in" } } } as Partial<TokenArg>)
      )
    ).not.toThrow();
  });

  // The extension cannot be added after InitializeMint, so this is a permanent
  // "no" rather than something a later configure call could fix.
  it.each(["custom", "arcade"])("refuses a %s token that did not enable it", (template) => {
    try {
      assertTokenSupportsConfidentialTransfers(token({ template } as Partial<TokenArg>));
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("CONFIDENTIAL_NOT_ENABLED");
    }
  });
});

describe("confidentialBalanceQuerySchema", () => {
  const WALLET = "So11111111111111111111111111111111111111112";

  // z.coerce.boolean() reads the string "false" as a non-empty string and so as
  // true, which would silently run the slow discrete-log search on every read.
  it("treats decryptPendingBalance=false as false", () => {
    const parsed = confidentialBalanceQuerySchema.parse({
      walletAddress: WALLET,
      decryptPendingBalance: "false",
    });
    expect(parsed.decryptPendingBalance).toBe(false);
  });

  it("treats decryptPendingBalance=true as true", () => {
    expect(
      confidentialBalanceQuerySchema.parse({ walletAddress: WALLET, decryptPendingBalance: "true" })
        .decryptPendingBalance
    ).toBe(true);
  });

  it("defaults to not decrypting the pending balance", () => {
    expect(
      confidentialBalanceQuerySchema.parse({ walletAddress: WALLET }).decryptPendingBalance
    ).toBe(false);
  });

  it("rejects a missing wallet address", () => {
    expect(confidentialBalanceQuerySchema.safeParse({}).success).toBe(false);
  });
});

// The SDK's guards throw plain Errors with no code, so the mapping is by message
// and these fixtures are copied verbatim from `@solana/mosaic-sdk`'s
// `assertConfidentialKeysMatchAccount`, `assertConfidentialKeysMatchSupply` and
// `confidentialMintBurnConversionError`. If upstream rewords them, this fails
// here instead of turning into an opaque 500 on a live request.
describe("toConfidentialAppError", () => {
  const ACCOUNT_MISMATCH =
    "The provided confidential keys' ElGamal public key (Abc) does not match token account Xyz's " +
    "registered key (Def). This happens when an account was configured under a previous " +
    "key-derivation scheme and its keys are re-derived under the current wallet-only one — they " +
    "are not the same keys. Use the retained key bytes from when the account was configured, " +
    "rather than re-deriving; or, if this account is unfamiliar, its data may be corrupt.";

  const SUPPLY_MISMATCH =
    "The provided supply keys' ElGamal public key (Abc) does not match mint Mint1's registered " +
    "supply key (Def). Supply keys are `deriveConfidentialKeys({ signer: supplyAuthority })` for " +
    "the wallet the mint was created with — most likely a different wallet signed the derivation. " +
    "Derivation is wallet-only, so neither the mint address nor the mint authority can re-derive " +
    "them: the supply-authority wallet itself must sign.";

  const MINT_BURN_CONVERSION =
    "Mint Mint1 has the ConfidentialMintBurn extension enabled; confidential deposit is not " +
    "supported. A ConfidentialMintBurn mint has no plaintext balance side.";

  it("maps an account key mismatch to a 409", () => {
    expect(toConfidentialAppError(new Error(ACCOUNT_MISMATCH))).toMatchObject({
      code: "CONFIDENTIAL_KEYS_MISMATCH",
    });
  });

  it("maps a supply key mismatch to its own 409", () => {
    expect(toConfidentialAppError(new Error(SUPPLY_MISMATCH))).toMatchObject({
      code: "CONFIDENTIAL_SUPPLY_KEYS_MISMATCH",
    });
  });

  it("maps a mint-burn conversion refusal to a 400", () => {
    expect(toConfidentialAppError(new Error(MINT_BURN_CONVERSION))).toMatchObject({
      code: "CONFIDENTIAL_MINT_BURN_CONVERSION",
    });
  });

  // The service wraps failures, so the match has to walk the cause chain rather
  // than reading only the outermost message.
  it("finds the guard through a wrapping error", () => {
    const wrapped = new Error("Transaction failed", { cause: new Error(ACCOUNT_MISMATCH) });
    expect(toConfidentialAppError(wrapped)).toMatchObject({
      code: "CONFIDENTIAL_KEYS_MISMATCH",
    });
  });

  it("leaves an unrelated failure for the generic handler", () => {
    expect(toConfidentialAppError(new Error("blockhash expired"))).toBeNull();
  });
});

describe("confidential mint/burn capability checks", () => {
  // No template implies an encrypted supply: it is offered on the custom template
  // alone, and only when explicitly configured.
  it.each(["custom", "stablecoin", "tokenized-security", "arcade"])(
    "refuses supply operations on a %s token without the extension",
    (template) => {
      expect(() =>
        assertTokenSupportsConfidentialMintBurn(token({ template } as Partial<TokenArg>))
      ).toThrow(expect.objectContaining({ code: "CONFIDENTIAL_NOT_ENABLED" }));
    }
  );

  it("allows supply operations once the extension is configured", () => {
    expect(() =>
      assertTokenSupportsConfidentialMintBurn(
        token({
          extensions: { confidentialMintBurn: { supplyAuthority: "So1111" } },
        } as Partial<TokenArg>)
      )
    ).not.toThrow();
  });

  it("refuses a conversion operation on a mint with an encrypted supply", () => {
    expect(() =>
      assertTokenNotConfidentialMintBurn(
        token({
          extensions: { confidentialMintBurn: { supplyAuthority: "So1111" } },
        } as Partial<TokenArg>),
        "minting"
      )
    ).toThrow(expect.objectContaining({ code: "CONFIDENTIAL_MINT_BURN_CONVERSION" }));
  });

  it("leaves an ordinary token alone", () => {
    expect(() => assertTokenNotConfidentialMintBurn(token({}), "minting")).not.toThrow();
  });
});
