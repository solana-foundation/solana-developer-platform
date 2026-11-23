import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { POST as resumeOperation } from "./operations/[operationId]/execute/route";
import { POST as executeOperation } from "./operations/route";
import { POST as registerRing } from "./rings/route";
import { POST as rekeyWallet } from "./wallets/[walletId]/rekey/route";
import { POST as provisionWallet } from "./wallets/route";

afterEach(() => vi.restoreAllMocks());

describe("Rings dashboard action routes", () => {
  it.each<[string, (request: Request) => Promise<Response>, string]>([
    ["rings", registerRing, "/v1/helius-rings/rings/register-and-initialize"],
    ["wallets", provisionWallet, "/v1/helius-rings/wallets/provision-identity"],
    ["operations", executeOperation, "/v1/helius-rings/operations/execute"],
    [
      "rekey",
      (request) => rekeyWallet(request, { params: Promise.resolve({ walletId: "wal/1" }) }),
      "/v1/helius-rings/wallets/wal%2F1/identity/rekey",
    ],
    [
      "execute",
      (request) => resumeOperation(request, { params: Promise.resolve({ operationId: "op/1" }) }),
      "/v1/helius-rings/operations/op%2F1/resume-execution",
    ],
  ])("%s forwards to its API action path", async (source, handle, path) => {
    const proxy = vi
      .spyOn(sdpApi, "proxyToSdpApi")
      .mockResolvedValue(NextResponse.json({ data: {} }));
    const request = new Request("https://dashboard.example.com/api/dashboard/helius-rings", {
      method: "POST",
    });
    await handle(request);
    expect(proxy).toHaveBeenCalledExactlyOnceWith({
      request,
      traceSource: `route.dashboard.helius-rings.${source}`,
      path,
    });
  });
});
