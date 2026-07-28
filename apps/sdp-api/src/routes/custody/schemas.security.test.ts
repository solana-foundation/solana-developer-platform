import { describe, expect, it } from "vitest";
import { initializeSigningSchema, switchSigningSchema } from "./schemas";

const hostedProviderRequests = [
  { provider: "privy" },
  { provider: "coinbase_cdp" },
  { provider: "para" },
  { provider: "turnkey" },
  { provider: "dfns" },
  { provider: "ibm_haven" },
  { provider: "anchorage" },
] as const;

describe.each([
  ["initialize", initializeSigningSchema],
  ["switch", switchSigningSchema],
] as const)("custody %s endpoint selection", (_operation, schema) => {
  it.each(hostedProviderRequests)("does not accept a client endpoint for $provider", (request) => {
    const parsed = schema.parse({
      ...request,
      apiBaseUrl: "https://untrusted.example",
    });

    expect(parsed).not.toHaveProperty("apiBaseUrl");
  });
});
