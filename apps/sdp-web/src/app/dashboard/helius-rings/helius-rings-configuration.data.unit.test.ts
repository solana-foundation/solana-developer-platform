import { afterEach, describe, expect, it, vi } from "vitest";
import { createRingsConnection, fetchRingsSetupStatus } from "./helius-rings-configuration.data";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Helius Rings configuration data", () => {
  it("reads the project setup status through its BFF route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            configured: false,
            source: "none",
            canManage: true,
            allowInsecureHttpAllowed: true,
            defaultConnection: null,
          },
        })
      )
    );

    await expect(fetchRingsSetupStatus()).resolves.toMatchObject({
      configured: false,
      source: "none",
    });
    expect(fetch).toHaveBeenCalledWith("/api/dashboard/helius-rings/setup-status", {
      cache: "no-store",
    });
  });

  it("keeps the optional custom Ring RPC in the saved connection bundle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            id: "hrconn_1",
            name: "Helius devnet",
            network: "devnet",
            status: "active",
            isDefault: true,
            allowInsecureHttp: false,
            endpoints: {},
          },
        })
      )
    );
    const input = {
      name: "Helius devnet",
      solanaRpcUrl: "https://rpc.example.test",
      indexerUrl: "https://indexer.example.test",
      proverUrl: "https://prover.example.test",
      ringRpcUrl: "https://d1ojzfopdqqs5r.cloudfront.net",
      allowInsecureHttp: false,
    };

    await createRingsConnection(input);

    expect(fetch).toHaveBeenCalledWith(
      "/api/dashboard/helius-rings/connections",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) })
    );
  });

  it("surfaces the API validation message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { message: "Solana RPC URL points to a host SDP cannot reach" } },
          { status: 400 }
        )
      )
    );

    await expect(
      createRingsConnection({
        name: "Blocked",
        solanaRpcUrl: "https://127.0.0.1",
        indexerUrl: "https://indexer.example.test",
        proverUrl: "https://prover.example.test",
        allowInsecureHttp: false,
      })
    ).rejects.toThrow("Solana RPC URL points to a host SDP cannot reach");
  });
});
