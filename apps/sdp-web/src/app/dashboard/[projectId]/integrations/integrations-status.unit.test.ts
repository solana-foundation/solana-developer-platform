import { describe, expect, it } from "vitest";
import {
  resolveComplianceIntegrations,
  resolveCustodyIntegrations,
  resolvePrivacyIntegrations,
  resolveRampIntegrations,
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
    // Manual provider awaiting a grant vs general provider this deployment
    // has not credentialed — the two must never collapse into one state.
    expect(custody.find((p) => p.entry.id === "fireblocks")?.status).toBe("request_access");
    expect(custody.find((p) => p.entry.id === "turnkey")?.status).toBe("not_configured");
  });

  it("keeps the self-hosted signer out of the catalog unless it actually signs here", () => {
    const hosted = resolveCustodyIntegrations({
      connectedProviders: ["privy"],
      enabledProviders: ["privy"],
    });
    expect(hosted.some((p) => p.entry.id === "local")).toBe(false);

    const selfHosted = resolveCustodyIntegrations({
      connectedProviders: ["local"],
      enabledProviders: [],
    });
    expect(selfHosted.find((p) => p.entry.id === "local")?.status).toBe("active");
  });

  it("never calls a payment rail connected, because no organization ever connected one", () => {
    // Every ramp is entitled to every organization by default, so `enabled`
    // reduces to "this deployment holds the secret". Reporting that as
    // Connected put MoonPay on every account that had never opened payments;
    // an on rail is Enabled, an off rail is a deployment gap, never access.
    const ramps = resolveRampIntegrations({
      moonpay: entry(true, true, true),
      coinbase: entry(true, false, true),
      mural: entry(false, true, true),
    });

    expect(ramps.find((p) => p.provider === "moonpay")?.status).toBe("enabled");
    expect(ramps.some((p) => p.status === "active")).toBe(false);
    expect(ramps.some((p) => p.status === "request_access")).toBe(false);
    expect(ramps.find((p) => p.provider === "coinbase")?.status).toBe("not_configured");
    expect(ramps.find((p) => p.provider === "mural")?.status).toBe("not_configured");
    expect(ramps.find((p) => p.provider === "bvnk")?.status).toBe("not_configured");
  });

  it("treats compliance as SDP-granted, with deployment gaps named as such", () => {
    const compliance = resolveComplianceIntegrations({
      range: entry(true, true, true),
      elliptic: entry(true, false, false),
    });
    expect(compliance).toHaveLength(4);
    expect(compliance.find((p) => p.provider === "range")?.status).toBe("enabled");
    // Activated for the organization, but this deployment lacks credentials.
    expect(compliance.find((p) => p.provider === "elliptic")?.status).toBe("not_configured");
    // Never activated: access is the missing piece.
    expect(compliance.find((p) => p.provider === "trm")?.status).toBe("request_access");
    expect(compliance.find((p) => p.provider === "chainalysis")?.status).toBe("request_access");
  });

  it("never renders a status that implies an integration does not exist", () => {
    const statuses = [
      ...resolveCustodyIntegrations({ connectedProviders: [], enabledProviders: [] }).map(
        (p) => p.status
      ),
      ...resolveRampIntegrations({}).map((p) => p.status),
      ...resolveComplianceIntegrations({}).map((p) => p.status),
    ];

    expect(statuses).not.toHaveLength(0);
    expect(
      statuses.every((s) =>
        ["active", "available", "enabled", "request_access", "not_configured"].includes(s)
      )
    ).toBe(true);
  });

  it("maps the feature-gated Private Channels instance onto catalog states", () => {
    const label = "Private Channels";
    expect(resolvePrivacyIntegrations({ enabled: false, active: true, label })).toEqual([]);
    expect(resolvePrivacyIntegrations({ enabled: true, active: true, label })[0]?.status).toBe(
      "active"
    );
    expect(resolvePrivacyIntegrations({ enabled: true, active: false, label })[0]?.status).toBe(
      "available"
    );
    expect(resolvePrivacyIntegrations({ enabled: true, active: null, label })[0]?.status).toBe(
      "unknown"
    );
  });
});
