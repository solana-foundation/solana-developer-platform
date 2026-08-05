import { describe, expect, it } from "vitest";
import { resolveCustodyProviderAvailability } from "./provider-display-status";

describe("custody provider availability", () => {
  it("lists every catalog provider rather than only the enabled ones", () => {
    const availability = resolveCustodyProviderAvailability({
      connectedProviders: [],
      enabledProviders: [],
    });

    expect(availability.map((provider) => provider.entry.id)).toEqual([
      "local",
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

  it("shows a provider with no setup route as unavailable rather than dropping it", () => {
    const availability = resolveCustodyProviderAvailability({
      connectedProviders: [],
      enabledProviders: [],
    });

    expect(availability.find((provider) => provider.entry.id === "turnkey")?.status).toBe(
      "unavailable"
    );
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
