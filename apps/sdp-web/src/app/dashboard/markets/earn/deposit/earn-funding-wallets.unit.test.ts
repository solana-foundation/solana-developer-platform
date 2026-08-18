import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFundingWallets } from "./earn-funding-wallets";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchFundingWallets", () => {
  it("fails closed when a successful response omits the wallet collection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { data: {} },
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(fetchFundingWallets()).rejects.toThrow("Invalid custody wallet response");
  });

  it("returns only active wallets from the live response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            wallets: [
              { id: "active", status: "active" },
              { id: "inactive", status: "inactive" },
            ],
          },
        })
      )
    );

    await expect(fetchFundingWallets()).resolves.toEqual([{ id: "active", status: "active" }]);
  });
});
