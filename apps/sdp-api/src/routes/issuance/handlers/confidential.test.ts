import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import { confidentialBalanceQuerySchema } from "../schemas";
import {
  assertTokenSupportsConfidentialTransfers,
  requireConfidentialTransfersDevnet,
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
