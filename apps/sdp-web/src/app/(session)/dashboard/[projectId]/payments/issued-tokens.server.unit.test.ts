import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ issuance: vi.fn() }));

// The deployment's Issuance flag, the gate's one ambient input.
vi.mock("@/flags", () => ({ issuance: flags.issuance }));

import {
  fetchIssuedTokenSymbolsWhenIssuanceEnabled,
  fetchIssuedTokensByMintWhenIssuanceEnabled,
} from "./issued-tokens.server";

describe("issued token reads behind the Issuance gate", () => {
  const symbol = { id: "tok_1", mintAddress: "Mint111", symbol: "ACME", imageUrl: null };
  const request = vi.fn(async (_path: string) =>
    Response.json({ data: [symbol], meta: { hasMore: false } })
  );

  beforeEach(() => {
    request.mockClear();
  });

  it("reads nothing where Issuance is off, so stable never asks for a refused route", async () => {
    flags.issuance.mockResolvedValue(false);

    expect(await fetchIssuedTokenSymbolsWhenIssuanceEnabled(request)).toEqual({
      ok: true,
      data: [],
    });
    expect(await fetchIssuedTokensByMintWhenIssuanceEnabled(request)).toEqual({});
    expect(request).not.toHaveBeenCalled();
  });

  it("reads the organization's issued tokens where Issuance is on", async () => {
    flags.issuance.mockResolvedValue(true);

    expect(await fetchIssuedTokenSymbolsWhenIssuanceEnabled(request)).toEqual({
      ok: true,
      data: [symbol],
    });
    expect(await fetchIssuedTokensByMintWhenIssuanceEnabled(request)).toEqual({
      Mint111: symbol,
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/issuance/tokens?page=1&pageSize=100",
      "/v1/issuance/tokens?page=1&pageSize=100",
    ]);
  });
});
