import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ issuance: vi.fn() }));

// The deployment's Issuance flag, the gate's one ambient input.
vi.mock("@/flags", () => ({ issuance: flags.issuance }));

import {
  fetchIssuedTokenSymbolsWhenIssuanceEnabled,
  fetchIssuedTokensByMintWhenIssuanceEnabled,
} from "./issued-tokens.server";
import * as paymentsPageData from "./payments-page.data";

describe("issued token reads behind the Issuance gate", () => {
  const request = vi.fn();
  const symbol = { id: "tok_1", mintAddress: "Mint111", symbol: "ACME", imageUrl: null };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(paymentsPageData, "fetchPaymentsIssuedTokenSymbols").mockResolvedValue({
      ok: true,
      data: [symbol],
    });
    vi.spyOn(paymentsPageData, "fetchIssuedTokensByMint").mockResolvedValue({ Mint111: symbol });
  });

  it("reads nothing where Issuance is off, so stable never asks for a refused route", async () => {
    flags.issuance.mockResolvedValue(false);

    await expect(fetchIssuedTokenSymbolsWhenIssuanceEnabled(request)).resolves.toEqual({
      ok: true,
      data: [],
    });
    await expect(fetchIssuedTokensByMintWhenIssuanceEnabled(request)).resolves.toEqual({});
    expect(paymentsPageData.fetchPaymentsIssuedTokenSymbols).not.toHaveBeenCalled();
    expect(paymentsPageData.fetchIssuedTokensByMint).not.toHaveBeenCalled();
  });

  it("reads the organization's issued tokens where Issuance is on", async () => {
    flags.issuance.mockResolvedValue(true);

    await expect(fetchIssuedTokenSymbolsWhenIssuanceEnabled(request)).resolves.toEqual({
      ok: true,
      data: [symbol],
    });
    await expect(fetchIssuedTokensByMintWhenIssuanceEnabled(request)).resolves.toEqual({
      Mint111: symbol,
    });
    expect(paymentsPageData.fetchPaymentsIssuedTokenSymbols).toHaveBeenCalledWith(request);
    expect(paymentsPageData.fetchIssuedTokensByMint).toHaveBeenCalledWith(request);
  });
});
