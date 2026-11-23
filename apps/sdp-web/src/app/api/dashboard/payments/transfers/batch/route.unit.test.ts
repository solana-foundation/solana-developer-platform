import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { POST } from "./route";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/dashboard/payments/transfers/batch", () => {
  it("proxies a batch send to the API's transfer batches", async () => {
    const proxy = vi
      .spyOn(sdpApi, "proxyToSdpApi")
      .mockResolvedValue(NextResponse.json({ data: {} }));
    const request = new Request(
      "https://dashboard.example/api/dashboard/payments/transfers/batch",
      { method: "POST" }
    );

    await POST(request);

    expect(proxy).toHaveBeenCalledWith({
      request,
      traceSource: "route.dashboard.payments.transfers.batch.post",
      path: "/v1/payments/transfer-batches/execute",
    });
  });
});
