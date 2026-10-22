import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiredWellKnownMint } from "@/test/well-known-mints";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));
vi.mock("@/lib/sdp-api", () => mocks);

import { GET } from "./route";

const USDC = requiredWellKnownMint("USDC", "devnet");

describe("token terms proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null));
  });

  it("forwards a mint address to the terms route", async () => {
    const request = new Request(
      `https://dashboard.example.test/api/dashboard/tokens/${USDC}/terms`
    );
    await GET(request, { params: Promise.resolve({ mint: USDC }) });
    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({ request, path: `/v1/tokens/${USDC}/terms` })
    );
  });

  it.each(["SOL", "not-a-mint", "../wallets"])("refuses %s before forwarding", async (mint) => {
    const response = await GET(new Request("https://dashboard.example.test/terms"), {
      params: Promise.resolve({ mint }),
    });
    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
