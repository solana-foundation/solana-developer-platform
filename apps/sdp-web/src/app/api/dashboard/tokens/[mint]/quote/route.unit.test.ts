import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiredWellKnownMint } from "@/test/well-known-mints";

const mocks = vi.hoisted(() => ({ proxyToSdpApi: vi.fn() }));
vi.mock("@/lib/sdp-api", () => mocks);

import { POST } from "./route";

const USDC = requiredWellKnownMint("USDC", "devnet");

describe("token amount quote proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyToSdpApi.mockResolvedValue(new Response(null));
  });

  it("forwards the quote request, body included, to the quote route", async () => {
    const request = new Request(
      `https://dashboard.example.test/api/dashboard/tokens/${USDC}/quote`,
      {
        method: "POST",
        body: JSON.stringify({ displayAmount: "10", basis: "credit" }),
      }
    );
    await POST(request, { params: Promise.resolve({ mint: USDC }) });
    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({ request, path: `/v1/tokens/${USDC}/quote` })
    );
  });

  it("refuses a value that is not a mint address before forwarding", async () => {
    const response = await POST(
      new Request("https://dashboard.example.test/quote", { method: "POST", body: "{}" }),
      { params: Promise.resolve({ mint: "SOL" }) }
    );
    expect(response.status).toBe(400);
    expect(mocks.proxyToSdpApi).not.toHaveBeenCalled();
  });
});
