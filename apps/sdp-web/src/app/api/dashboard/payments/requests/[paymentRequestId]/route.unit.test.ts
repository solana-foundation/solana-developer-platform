import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { GET } from "./route";

function detailRequest(): Request {
  return new Request("https://dashboard.example.com/api/dashboard/payments/requests/preq_1");
}

describe("GET /api/dashboard/payments/requests/[paymentRequestId]", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the request from the API", async () => {
    const proxy = vi
      .spyOn(sdpApi, "proxyToSdpApi")
      .mockResolvedValue(NextResponse.json({ data: {} }));
    const request = detailRequest();

    await GET(request, { params: Promise.resolve({ paymentRequestId: "preq_1" }) });

    expect(proxy).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payment-requests.detail",
      path: "/v1/payments/requests/preq_1",
    });
  });

  it("returns 400 for a blank id without proxying", async () => {
    const proxy = vi.spyOn(sdpApi, "proxyToSdpApi");

    const response = await GET(detailRequest(), {
      params: Promise.resolve({ paymentRequestId: " " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Payment request id is required" },
    });
    expect(proxy).not.toHaveBeenCalled();
  });
});
