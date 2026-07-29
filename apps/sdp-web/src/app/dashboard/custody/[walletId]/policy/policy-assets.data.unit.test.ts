import { describe, expect, it, vi } from "vitest";
import { getIssuedPolicyTokens } from "./policy-assets.data";

function tokenPage(
  rows: Array<{ mintAddress?: string | null; symbol?: string | null; name?: string | null }>,
  meta: Partial<{ hasMore: boolean }> = {}
): Response {
  return Response.json({ data: rows, meta: { hasMore: false, ...meta } });
}

describe("getIssuedPolicyTokens", () => {
  it("returns an empty list when the caller cannot read tokens", async () => {
    const request = vi.fn(async () => new Response(null, { status: 403 }));

    await expect(getIssuedPolicyTokens(request)).resolves.toEqual([]);
  });

  it("does not throw when the request rejects", async () => {
    const request = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(getIssuedPolicyTokens(request)).resolves.toEqual([]);
  });

  it("drops rows that have no usable mint address", async () => {
    const request = vi.fn(async () =>
      tokenPage([
        { mintAddress: null, symbol: "PEND", name: "Not deployed yet" },
        { mintAddress: "   ", symbol: "BLANK", name: "Blank mint" },
        { mintAddress: "MintAcme", symbol: "ACME", name: "Acme Token" },
      ])
    );

    await expect(getIssuedPolicyTokens(request)).resolves.toEqual([
      { token: "ACME", name: "Acme Token", mint: "MintAcme" },
    ]);
  });

  it("stops after one page when the response carries no hasMore", async () => {
    const request = vi.fn(async () =>
      Response.json({ data: [{ mintAddress: "MintAcme", symbol: "ACME" }] })
    );

    await getIssuedPolicyTokens(request);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reads the nested tokens shape as well as a bare array", async () => {
    const request = vi.fn(async () =>
      Response.json({
        data: { tokens: [{ mintAddress: "MintBeta", symbol: "BETA", name: "Beta Token" }] },
        meta: { hasMore: false },
      })
    );

    await expect(getIssuedPolicyTokens(request)).resolves.toEqual([
      { token: "BETA", name: "Beta Token", mint: "MintBeta" },
    ]);
  });

  it("falls back to the mint when a row has no symbol or name", async () => {
    const request = vi.fn(async () => tokenPage([{ mintAddress: "MintBare" }]));

    await expect(getIssuedPolicyTokens(request)).resolves.toEqual([
      { token: "MintBare", name: "MintBare", mint: "MintBare" },
    ]);
  });

  it("caps the request count, warns, and returns what it collected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let issued = 0;
    const request = vi.fn(async () => {
      issued += 1;
      return tokenPage([{ mintAddress: `Mint${issued}`, symbol: `T${issued}` }], { hasMore: true });
    });

    const result = await getIssuedPolicyTokens(request);

    expect(request).toHaveBeenCalledTimes(5);
    expect(result).toHaveLength(5);
    expect(warn).toHaveBeenCalledOnce();

    warn.mockRestore();
  });
});
