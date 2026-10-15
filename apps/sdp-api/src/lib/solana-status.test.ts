import type { StatuspageComponentStatus } from "@sdp/types/network-metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMainnetClusterHealth, mainnetClusterHealth } from "./solana-status";

const page = (status: StatuspageComponentStatus) => ({
  page: { id: "rm9mn997x8jd", name: "Solana" },
  components: [
    { id: "b21c1qbg5g4n", name: "Mainnet Beta - RPC Nodes", status: "major_outage" as const },
    { id: "qxs6x3yc9cxg", name: "Mainnet Beta - Cluster", status },
  ],
});

describe("mainnetClusterHealth", () => {
  it.each([
    ["operational", "operational"],
    ["degraded_performance", "degraded"],
    ["partial_outage", "outage"],
    ["major_outage", "outage"],
    ["under_maintenance", "maintenance"],
  ] as const)("reads the cluster's %s as %s, not the RPC nodes'", (status, health) => {
    expect(mainnetClusterHealth(page(status))).toBe(health);
  });

  it("claims nothing when the page leaves the cluster out", () => {
    expect(mainnetClusterHealth({ components: [] })).toBeNull();
  });
});

describe("fetchMainnetClusterHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the cluster's state from the status page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(page("degraded_performance")), { status: 200 })
    );
    await expect(fetchMainnetClusterHealth()).resolves.toBe("degraded");
  });

  it.each([
    ["does not answer", new Response("", { status: 503 })],
    ["answers with a page, not JSON", new Response("<html>", { status: 200 })],
    ["answers in another shape", Response.json({ status: { indicator: "none" } })],
    [
      "reports a state it does not know",
      Response.json({ components: [{ id: "qxs6x3yc9cxg", status: "investigating" }] }),
    ],
  ])("fails rather than guess when the page %s", async (_case, response) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(fetchMainnetClusterHealth()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});
