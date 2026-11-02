import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issuance: vi.fn(),
  fetchIssuedTokensByMint: vi.fn(),
  fetchPaymentsIssuedTokenSymbols: vi.fn(),
}));

vi.mock("@/flags", () => ({ issuance: mocks.issuance }));
vi.mock("./payments-page.data", () => ({
  fetchIssuedTokensByMint: mocks.fetchIssuedTokensByMint,
  fetchPaymentsIssuedTokenSymbols: mocks.fetchPaymentsIssuedTokenSymbols,
}));

import {
  fetchIssuedTokenSymbolsWhenIssuanceEnabled,
  fetchIssuedTokensByMintWhenIssuanceEnabled,
} from "./issued-tokens.server";

describe("issued token reads behind the Issuance gate", () => {
  const request = vi.fn();
  const symbol = { id: "tok_1", mintAddress: "Mint111", symbol: "ACME" };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchPaymentsIssuedTokenSymbols.mockResolvedValue({ ok: true, data: [symbol] });
    mocks.fetchIssuedTokensByMint.mockResolvedValue({ Mint111: symbol });
  });

  it("reads nothing where Issuance is off, so stable never asks for a refused route", async () => {
    mocks.issuance.mockResolvedValue(false);

    await expect(fetchIssuedTokenSymbolsWhenIssuanceEnabled(request)).resolves.toEqual({
      ok: true,
      data: [],
    });
    await expect(fetchIssuedTokensByMintWhenIssuanceEnabled(request)).resolves.toEqual({});
    expect(mocks.fetchPaymentsIssuedTokenSymbols).not.toHaveBeenCalled();
    expect(mocks.fetchIssuedTokensByMint).not.toHaveBeenCalled();
  });

  it("reads the organization's issued tokens where Issuance is on", async () => {
    mocks.issuance.mockResolvedValue(true);

    await expect(fetchIssuedTokenSymbolsWhenIssuanceEnabled(request)).resolves.toEqual({
      ok: true,
      data: [symbol],
    });
    await expect(fetchIssuedTokensByMintWhenIssuanceEnabled(request)).resolves.toEqual({
      Mint111: symbol,
    });
    expect(mocks.fetchPaymentsIssuedTokenSymbols).toHaveBeenCalledWith(request);
    expect(mocks.fetchIssuedTokensByMint).toHaveBeenCalledWith(request);
  });
});
