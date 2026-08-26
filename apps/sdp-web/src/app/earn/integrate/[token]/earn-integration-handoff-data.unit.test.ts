import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPublicEarnButtonConfiguration } from "./earn-integration-handoff-data";

const validResponse = {
  data: {
    configuration: {
      strategyId: "earn_strategy_example",
      strategyName: "USDC Yield Vault",
      provider: "kamino",
      style: "accent",
      accentColor: "#9945FF",
      strategyAvailable: true,
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadPublicEarnButtonConfiguration", () => {
  it("returns the public configuration for a valid handoff", async () => {
    const fetchMock = vi.fn(async () => Response.json(validResponse));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      loadPublicEarnButtonConfiguration("https://api.example.test", "public/token")
    ).resolves.toEqual(validResponse.data.configuration);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/earn/button-configurations/public/public%2Ftoken",
      { cache: "no-store" }
    );
  });

  it("returns missing for a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 }))
    );

    await expect(
      loadPublicEarnButtonConfiguration("https://api.example.test", "missing-token")
    ).resolves.toBeNull();
  });

  it.each([403, 429, 503])(
    "degrades an operational %i response to missing instead of crashing the page",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status }))
      );

      await expect(
        loadPublicEarnButtonConfiguration("https://api.example.test", "valid-token")
      ).resolves.toBeNull();
    }
  );

  it("rejects a malformed successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: {} }))
    );

    await expect(
      loadPublicEarnButtonConfiguration("https://api.example.test", "valid-token")
    ).rejects.toThrow("Earn integration handoff returned an invalid response");
  });
});
