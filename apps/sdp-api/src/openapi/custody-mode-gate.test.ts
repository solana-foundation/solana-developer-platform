import type { OpenAPIObject } from "openapi3-ts/oas30";
import { describe, expect, it, vi } from "vitest";
import { CUSTODY_MODE_GATE, pruneUnpublishedValues } from "./release-channel-values";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/types/release-channels")>();
  return {
    ...actual,
    // Model a channel where managed custody has shipped but BYOK has not.
    isCustodyProviderInReleaseChannel: (
      channel: Parameters<typeof actual.isCustodyProviderInReleaseChannel>[0],
      provider: Parameters<typeof actual.isCustodyProviderInReleaseChannel>[1],
      mode: Parameters<typeof actual.isCustodyProviderInReleaseChannel>[2]
    ) =>
      mode === "byok" && channel === "stable"
        ? false
        : actual.isCustodyProviderInReleaseChannel(channel, provider, mode),
  };
});

const document: OpenAPIObject = {
  openapi: "3.0.0",
  info: { title: "Policy", version: "1" },
  paths: {},
  components: {
    schemas: {
      Wallet: {
        type: "object",
        required: ["providerPolicy"],
        properties: {
          id: { type: "string" },
          providerPolicy: { type: "object", [CUSTODY_MODE_GATE]: "byok" },
        },
      },
    },
  },
};

describe("custody mode publication", () => {
  it("drops the BYOK field without dropping the managed wallet schema", () => {
    expect(pruneUnpublishedValues(document, "stable").components?.schemas?.Wallet).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
    });
  });
  it("publishes the field where BYOK is available and strips internal gate metadata", () => {
    const published = pruneUnpublishedValues(document, "experimental");
    expect(published.components?.schemas?.Wallet).toEqual({
      type: "object",
      required: ["providerPolicy"],
      properties: {
        id: { type: "string" },
        providerPolicy: { type: "object" },
      },
    });
    expect(JSON.stringify(published)).not.toContain(CUSTODY_MODE_GATE);
  });
});
