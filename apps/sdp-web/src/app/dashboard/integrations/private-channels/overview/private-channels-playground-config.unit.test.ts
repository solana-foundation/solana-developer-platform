import { describe, expect, it } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { buildPrivateChannelsPlaygroundEndpointConfigs } from "./private-channels-playground-config";

describe("buildPrivateChannelsPlaygroundEndpointConfigs", () => {
  const messages = getMessages("en");
  const t = (
    key: Parameters<typeof translate<typeof messages>>[1],
    values?: Record<string, string | number>
  ) => translate(messages, key, values);

  it("builds literal path field labels rather than raw interpolation tokens", () => {
    // Regression guard: earlier versions rendered "{id}" via string templates and
    // tripped the i18n auditor. Labels must be plain literals so they're both
    // auditable and human-readable in the form.
    const configs = buildPrivateChannelsPlaygroundEndpointConfigs(t);

    expect(
      configs.find(({ id }) => id === "get-private-channel-deposit")?.pathFields[0]?.label
    ).toBe("{id}");
    expect(configs.find(({ id }) => id === "get-private-channel")?.pathFields[0]?.label).toBe(
      "{id}"
    );
  });

  it("does not include session-only operations that would 401 under API-key auth", () => {
    // These operations require a dashboard session (see paths/private-channels.ts
    // security: [{ sessionCookie: [] }]). The playground executes with an API
    // key, so surfacing them would just show 401 responses. The generator filter
    // in scripts/generate-playground-catalog.ts drops them; this test pins the
    // outcome against silent regressions in either the tag or the filter.
    const configs = buildPrivateChannelsPlaygroundEndpointConfigs(t);
    const ids = new Set(configs.map((endpoint) => endpoint.id));

    expect(ids.has("get-private-channel-balance")).toBe(false);
    expect(ids.has("create-private-channel-deposit")).toBe(false);
    expect(ids.has("create-private-channel-withdrawal")).toBe(false);
    expect(ids.has("list-private-channel-transfer-recipients")).toBe(false);
    expect(ids.has("create-private-channel-transfer")).toBe(false);
    expect(ids.has("verify-private-channel-wallet")).toBe(false);
    expect(ids.has("delete-private-channel-verified-wallet")).toBe(false);
    expect(ids.has("list-private-channel-verified-wallets")).toBe(false);
  });

  it("preloads the sandbox constants on the connect form so it works out of the box", () => {
    // Sandbox constants live in PROPOSAL.md §0 — the playground is only useful
    // when someone can hit Run against an instance without hunting for the
    // gateway URL. Regressing these defaults breaks that first-run experience.
    const configs = buildPrivateChannelsPlaygroundEndpointConfigs(t);
    const connect = configs.find(({ id }) => id === "connect-private-channel-instance");

    expect(connect?.bodyFields.find((f) => f.key === "gatewayUrl")?.defaultValue).toBe(
      "http://34.71.147.163:8899"
    );
    expect(connect?.bodyFields.find((f) => f.key === "escrowProgramId")?.defaultValue).toBe(
      "9tgHa1DcnaSSUtmMsst8ovKTe1Gfxzezn27KnH9xXYeU"
    );
    expect(connect?.bodyFields.find((f) => f.key === "withdrawProgramId")?.defaultValue).toBe(
      "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi"
    );
    expect(connect?.bodyFields.find((f) => f.key === "escrowInstanceAddr")?.defaultValue).toBe(
      "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz"
    );
  });

  it("exposes only the hand-curated operations while SPC is out of the public spec", () => {
    // Private Channels is intentionally not in the public OpenAPI doc yet
    // (feature flag off + security review pending), so the generated catalog
    // contributes zero SPC operations. Only the curated entries in this file
    // show up in the playground until the module is promoted.
    const configs = buildPrivateChannelsPlaygroundEndpointConfigs(t);
    const ids = new Set(configs.map((endpoint) => endpoint.id));

    expect(ids.has("get-private-channel-instance")).toBe(true);
    expect(ids.has("connect-private-channel-instance")).toBe(true);
    expect(ids.has("create-private-channel")).toBe(true);
  });
});
