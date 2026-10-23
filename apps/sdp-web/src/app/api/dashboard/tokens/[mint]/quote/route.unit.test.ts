import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { POST } from "./route";

const USDC = requiredWellKnownMint("USDC", "devnet");
const proxy = vi.spyOn(sdpApi, "proxyToSdpApi");

describe("token amount quote proxy", () => {
  beforeEach(() => {
    proxy.mockReset().mockResolvedValue(new NextResponse(null));
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
    expect(proxy).toHaveBeenCalledWith(
      expect.objectContaining({ request, path: `/v1/tokens/${USDC}/quote` })
    );
  });

  it("refuses a value that is not a mint address before forwarding", async () => {
    const response = await POST(
      new Request("https://dashboard.example.test/quote", { method: "POST", body: "{}" }),
      { params: Promise.resolve({ mint: "SOL" }) }
    );
    expect(response.status).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
  });
});
