import type { WalletApprovalRequestSummary } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchApprovalRequests } from "./approval-requests.server";

describe("fetchApprovalRequests", () => {
  it("keeps pending requests even when they are outside the recent mixed result", async () => {
    const pending = { id: "pending" } as WalletApprovalRequestSummary;
    const recent = { id: "recent" } as WalletApprovalRequestSummary;
    const fetch = vi.fn();
    fetch
      .mockResolvedValueOnce({ approvalRequests: [pending] })
      .mockResolvedValueOnce({ approvalRequests: [recent] });

    const requests = await fetchApprovalRequests({ fetch } as unknown as SdpApiClient);

    expect(requests).toEqual([pending, recent]);
    expect(fetch).toHaveBeenCalledWith("/v1/wallets/approval-requests?status=pending&limit=100");
    expect(fetch).toHaveBeenCalledWith("/v1/wallets/approval-requests?limit=100");
  });

  it("deduplicates pending requests returned by both queries", async () => {
    const pending = { id: "pending" } as WalletApprovalRequestSummary;
    const fetch = vi.fn().mockResolvedValue({ approvalRequests: [pending] });

    await expect(fetchApprovalRequests({ fetch } as unknown as SdpApiClient)).resolves.toEqual([
      pending,
    ]);
  });
});
