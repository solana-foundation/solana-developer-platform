import { describe, expect, it } from "vitest";
import { resolveCustodyProviderAvailability } from "./provider-display-status";

describe("custody provider availability", () => {
  it("lists every catalog provider rather than only the enabled ones", () => {
    const availability = resolveCustodyProviderAvailability({
      connectedProviders: [],
      enabledProviders: [],
    });

    // The self-hosted signer is the one omission: it is a deployment mode, not
    // something an organization can be granted, so it appears only where the
    // deployment actually runs it.
    expect(availability.map((provider) => provider.entry.id)).toEqual([
      "privy",
      "fireblocks",
      "coinbase_cdp",
      "para",
      "turnkey",
      "dfns",
      "ibm_haven",
      "anchorage",
      "utila",
    ]);
  });

  it("keeps the self-hosted signer whenever the deployment actually runs one", () => {
    const enabled = resolveCustodyProviderAvailability({
      connectedProviders: [],
      enabledProviders: ["local"],
    });
    expect(enabled.find((provider) => provider.entry.id === "local")?.status).toBe("available");

    const connected = resolveCustodyProviderAvailability({
      connectedProviders: ["local"],
      enabledProviders: [],
    });
    expect(connected.find((provider) => provider.entry.id === "local")?.status).toBe("active");
  });

  it("marks a provider with an active config as active even when it is also enabled", () => {
    const availability = resolveCustodyProviderAvailability({
      connectedProviders: ["privy"],
      enabledProviders: ["privy"],
    });

    expect(availability.find((provider) => provider.entry.id === "privy")?.status).toBe("active");
  });

  it("marks an enabled but unconnected provider as available", () => {
    const availability = resolveCustodyProviderAvailability({
      connectedProviders: [],
      enabledProviders: ["privy"],
    });

    expect(availability.find((provider) => provider.entry.id === "privy")?.status).toBe(
      "available"
    );
  });

  it("offers gated providers a request-access route instead of hiding them", () => {
    const fireblocks = resolveCustodyProviderAvailability({
      connectedProviders: [],
      enabledProviders: [],
    }).find((provider) => provider.entry.id === "fireblocks");

    expect(fireblocks?.status).toBe("request_access");
    expect(fireblocks?.requestAccessUrl).toBe("https://solanafoundation.typeform.com/to/wShiq9SN");
  });

  it("keeps a gated provider's active connection ahead of its request-access route", () => {
    const fireblocks = resolveCustodyProviderAvailability({
      connectedProviders: ["fireblocks"],
      enabledProviders: [],
    }).find((provider) => provider.entry.id === "fireblocks");

    expect(fireblocks?.status).toBe("active");
    expect(fireblocks?.requestAccessUrl).toBeUndefined();
  });

  it("splits not-enabled providers into access to request and credentials this deployment lacks", () => {
    const availability = resolveCustodyProviderAvailability({
      connectedProviders: [],
      enabledProviders: [],
    });

    // Manual providers are organization access the SDP team grants, but only
    // Fireblocks carries a request route today. Saying "request access" with
    // no way to request it is a dead end, so the rest hold at not-configured
    // until HOO-775 wires their routes.
    for (const id of ["ibm_haven", "dfns", "anchorage", "utila"] as const) {
      const provider = availability.find((candidate) => candidate.entry.id === id);
      expect(provider?.status).toBe("not_configured");
      expect(provider?.requestAccessUrl).toBeUndefined();
    }

    // Generally available providers gate only on deployment credentials.
    for (const id of ["privy", "coinbase_cdp", "para", "turnkey"] as const) {
      expect(availability.find((candidate) => candidate.entry.id === id)?.status).toBe(
        "not_configured"
      );
    }
  });

  it("only lets active and available providers be selected", () => {
    const availability = resolveCustodyProviderAvailability({
      connectedProviders: ["privy"],
      enabledProviders: ["local"],
    });

    const selectable = availability
      .filter((provider) => provider.isSelectable)
      .map((provider) => provider.entry.id);

    expect(selectable).toEqual(["local", "privy"]);
  });

  it("groups providers by category without losing any of them", () => {
    const availability = resolveCustodyProviderAvailability({
      connectedProviders: [],
      enabledProviders: [],
    });

    const server = availability.filter((provider) => provider.entry.category === "server");
    const institutional = availability.filter(
      (provider) => provider.entry.category === "institutional"
    );

    expect(server).not.toHaveLength(0);
    expect(institutional).not.toHaveLength(0);
    expect(server.length + institutional.length).toBe(availability.length);
  });
});
