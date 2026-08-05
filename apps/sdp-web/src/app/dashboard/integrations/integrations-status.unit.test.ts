import { describe, expect, it } from "vitest";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolveRampIntegrations,
  resolveRpcIntegrations,
} from "./integrations-status";

const entry = (entitled: boolean, configured: boolean, enabled: boolean) => ({
  entitled,
  configured,
  enabled,
});

describe("integrations status", () => {
  it("keeps the custody family on the same vocabulary as the setup step", () => {
    const custody = resolveCustodyIntegrations({
      connectedProviders: ["privy"],
      enabledProviders: ["privy", "para"],
    });

    expect(custody.find((p) => p.entry.id === "privy")?.status).toBe("active");
    expect(custody.find((p) => p.entry.id === "para")?.status).toBe("available");
    expect(custody.find((p) => p.entry.id === "fireblocks")?.status).toBe("request_access");
    expect(custody.find((p) => p.entry.id === "turnkey")?.status).toBe("unavailable");
  });

  it("marks the organization's selected RPC provider active and the rest switchable", () => {
    const rpc = resolveRpcIntegrations({
      selectedProvider: "helius",
      entries: {
        helius: entry(true, true, true),
        alchemy: entry(true, true, true),
        triton: entry(true, true, false),
      },
    });

    expect(rpc.find((p) => p.provider === "helius")?.status).toBe("active");
    expect(rpc.find((p) => p.provider === "alchemy")?.status).toBe("available");
    expect(rpc.find((p) => p.provider === "triton")?.status).toBe("unavailable");
  });

  it("treats a missing RPC setting as running on SDP's default", () => {
    // The page maps a null stored setting to "default" before resolving, so
    // the catalog always names exactly one active RPC provider.
    const rpc = resolveRpcIntegrations({ selectedProvider: "default", entries: {} });
    expect(rpc.find((p) => p.provider === "default")?.status).toBe("active");
    expect(rpc.filter((p) => p.status === "active")).toHaveLength(1);
  });

  it("only names SDP's own RPC while the organization actually runs on it", () => {
    const onDefault = resolveRpcIntegrations({ selectedProvider: "default", entries: {} });
    expect(onDefault.find((p) => p.provider === "default")?.status).toBe("active");

    const onVendor = resolveRpcIntegrations({ selectedProvider: "helius", entries: {} });
    expect(onVendor.some((p) => p.provider === "default")).toBe(false);
  });

  it("requires entitled, configured and enabled together for an active ramp", () => {
    const ramps = resolveRampIntegrations({
      moonpay: entry(true, true, true),
      coinbase: entry(true, false, true),
      mural: entry(false, true, true),
    });

    expect(ramps.find((p) => p.provider === "moonpay")?.status).toBe("active");
    expect(ramps.find((p) => p.provider === "coinbase")?.status).toBe("unavailable");
    expect(ramps.find((p) => p.provider === "mural")?.status).toBe("unavailable");
    // Providers with no entry at all still appear, honestly unavailable.
    expect(ramps.find((p) => p.provider === "bvnk")?.status).toBe("unavailable");
  });

  it("lists every compliance provider even though none are entitled by default", () => {
    const compliance = resolveComplianceIntegrations({});
    expect(compliance).toHaveLength(4);
    expect(compliance.every((p) => p.status === "unavailable")).toBe(true);
  });
});
