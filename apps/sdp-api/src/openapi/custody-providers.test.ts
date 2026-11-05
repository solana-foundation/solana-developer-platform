import { CUSTODY_MODES, CUSTODY_PROVIDERS, type CustodyMode } from "@sdp/types/custody";
import {
  isCustodyProviderInReleaseChannel,
  SDP_RELEASE_CHANNEL_NAMES,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { CUSTODY_MODE_GATE } from "./release-channel-values";
import { createPublicOpenApiDocument, createPublicSurfaceManifest } from "./spec";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const valuesSchema = z.array(z.string());
const nodesSchema = z.array(z.unknown());

/** The value at `path` below `node`, or undefined where the document has none. */
function at(node: unknown, ...path: readonly (string | number)[]): unknown {
  let current = node;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function enumOf(schema: unknown): string[] | undefined {
  return valuesSchema.optional().parse(at(schema, "enum"));
}

function requestBody(document: OpenAPIObject, path: string, method: string): unknown {
  return at(
    document,
    "paths",
    path,
    method,
    "requestBody",
    "content",
    "application/json",
    "schema"
  );
}

function providerQueryEnum(document: OpenAPIObject, path: string): string[] | undefined {
  const parameters = nodesSchema.parse(at(document, "paths", path, "get", "parameters"));
  return enumOf(
    at(
      parameters.find((parameter) => at(parameter, "name") === "provider"),
      "schema"
    )
  );
}

/** The custody provider lists of every request that names one. */
function requestProviders(document: OpenAPIObject) {
  const initialize = nodesSchema.parse(
    at(requestBody(document, "/v1/wallets/initialize", "post"), "oneOf")
  );
  return {
    initialize: initialize.flatMap((branch) => enumOf(at(branch, "properties", "provider")) ?? []),
    create: enumOf(
      at(requestBody(document, "/v1/wallets", "post"), "anyOf", 0, "properties", "provider")
    ),
    delete: enumOf(at(requestBody(document, "/v1/wallets", "delete"), "properties", "provider")),
    list: providerQueryEnum(document, "/v1/wallets"),
    aggregate: providerQueryEnum(document, "/v1/wallets/aggregate"),
  };
}

/** The `provider` schema of every response that names a custody provider. */
function responseProviderSchemas(document: OpenAPIObject): unknown[] {
  const data = (path: string, method: string, status: string) =>
    at(
      document,
      "paths",
      path,
      method,
      "responses",
      status,
      "content",
      "application/json",
      "schema",
      "properties",
      "data",
      "properties"
    );
  const availability = nodesSchema.parse(
    at(
      data("/v1/projects/{projectId}/provider-availability", "get", "200"),
      "providers",
      "items",
      "oneOf"
    )
  );
  return [
    at(data("/v1/wallets", "post", "201"), "wallet", "properties", "provider"),
    at(data("/v1/wallets", "get", "200"), "wallets", "items", "properties", "provider"),
    at(data("/v1/wallets/configs", "get", "200"), "configs", "items", "properties", "provider"),
    at(data("/v1/wallets/{walletId}", "get", "200"), "wallet", "properties", "provider"),
    at(data("/v1/wallets/{walletId}", "patch", "200"), "wallet", "properties", "provider"),
    at(
      availability.find((branch) =>
        enumOf(at(branch, "properties", "family"))?.includes("custody")
      ),
      "properties",
      "provider"
    ),
  ];
}

/** The custody providers `releaseChannel` offers in at least one of `modes`. */
function offeredIn(releaseChannel: SdpReleaseChannel, modes: readonly CustodyMode[]): string[] {
  return CUSTODY_PROVIDERS.filter((provider) =>
    modes.some((mode) => isCustodyProviderInReleaseChannel(releaseChannel, provider, mode))
  );
}

describe("custody providers in the public OpenAPI document", () => {
  beforeEach(() => {
    custodyReleaseChannel.outOfChannelMode = null;
    custodyReleaseChannel.stageOverride = null;
  });

  // Custody launches one (provider, mode) pair at a time (release-channels.ts). A
  // Managed-only request lists the providers the channel offers for Managed
  // custody; any other request, those it offers in some mode.
  for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
    it(`${releaseChannel}: lists the custody providers its release channel offers`, () => {
      const managed = offeredIn(releaseChannel, ["managed"]);
      const anyMode = offeredIn(releaseChannel, CUSTODY_MODES);

      expect(requestProviders(createPublicOpenApiDocument({ releaseChannel }))).toEqual({
        initialize: managed,
        create: managed,
        delete: managed,
        list: anyMode,
        aggregate: anyMode,
      });
      expect(createPublicSurfaceManifest(releaseChannel).custodyProviders).toEqual(anyMode);
    });
  }

  it("documents Privy alone for production and every provider for dev", () => {
    expect(requestProviders(createPublicOpenApiDocument({ releaseChannel: "stable" }))).toEqual({
      initialize: ["privy"],
      create: ["privy"],
      delete: ["privy"],
      list: ["privy"],
      aggregate: ["privy"],
    });
    const experimental = requestProviders(
      createPublicOpenApiDocument({ releaseChannel: "experimental" })
    );
    for (const providers of Object.values(experimental)) {
      expect(providers).toEqual([...CUSTODY_PROVIDERS]);
    }
  });

  // Reads still return a wallet, config or availability entry whose provider the
  // channel stopped offering, so response enums open up instead of narrowing.
  it.each([
    ["stable", undefined],
    ["experimental", [...CUSTODY_PROVIDERS]],
  ] as const)("%s: response provider enums are %j", (releaseChannel, expected) => {
    const schemas = responseProviderSchemas(createPublicOpenApiDocument({ releaseChannel }));

    expect(schemas).toHaveLength(6);
    for (const schema of schemas) {
      expect(schema).toMatchObject({ type: "string" });
      expect(enumOf(schema)).toEqual(expected);
    }
  });

  it("leaves no custody mode gate in any channel's document", () => {
    for (const releaseChannel of SDP_RELEASE_CHANNEL_NAMES) {
      expect(JSON.stringify(createPublicOpenApiDocument({ releaseChannel }))).not.toContain(
        CUSTODY_MODE_GATE
      );
    }
  });

  // Production projects run BYOK only, so a BYOK pair can reach stable before its
  // Managed twin; the Managed-only requests must not list it then.
  it("keeps a provider offered for BYOK alone out of Managed-only requests", () => {
    custodyReleaseChannel.stageOverride = { provider: "fireblocks", mode: "byok", stage: "stable" };

    expect(requestProviders(createPublicOpenApiDocument({ releaseChannel: "stable" }))).toEqual({
      initialize: ["privy"],
      create: ["privy"],
      delete: ["privy"],
      list: ["fireblocks", "privy"],
      aggregate: ["fireblocks", "privy"],
    });
    expect(createPublicSurfaceManifest("stable").custodyProviders).toEqual(["fireblocks", "privy"]);
  });
});
