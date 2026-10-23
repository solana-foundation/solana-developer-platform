import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { GET } from "./route";

const USDC = requiredWellKnownMint("USDC", "devnet");
const proxy = vi.spyOn(sdpApi, "proxyToSdpApi");

describe("token terms proxy", () => {
  beforeEach(() => {
    proxy.mockReset().mockResolvedValue(new NextResponse(null));
  });

  it("forwards a mint address to the terms route", async () => {
    const request = new Request(
      `https://dashboard.example.test/api/dashboard/tokens/${USDC}/terms`
    );
    await GET(request, { params: Promise.resolve({ mint: USDC }) });
    expect(proxy).toHaveBeenCalledWith(
      expect.objectContaining({ request, path: `/v1/tokens/${USDC}/terms` })
    );
  });

  it.each(["SOL", "not-a-mint", "../wallets"])("refuses %s before forwarding", async (mint) => {
    const response = await GET(new Request("https://dashboard.example.test/terms"), {
      params: Promise.resolve({ mint }),
    });
    expect(response.status).toBe(400);
    expect(proxy).not.toHaveBeenCalled();
  });
});
