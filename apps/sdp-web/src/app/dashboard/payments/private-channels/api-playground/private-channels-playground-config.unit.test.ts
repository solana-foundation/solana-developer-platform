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
    // that tripped the i18n auditor. The labels must be plain literals composed
    // by hand so they're both auditable and human-readable in the form.
    const configs = buildPrivateChannelsPlaygroundEndpointConfigs(t);

    expect(configs.find(({ id }) => id === "get-private-channel-deposit")?.pathFields[0]?.label)
      .toBe("{id}");
    expect(
      configs.find(({ id }) => id === "list-private-channel-transfer-recipients")?.pathFields[0]
        ?.label
    ).toBe("{channelId}");
    expect(configs.find(({ id }) => id === "verify-private-channel-wallet")?.pathFields[0]?.label)
      .toBe("{walletId}");
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

  it("merges every generated SPC operation so no public endpoint is hidden", () => {
    // The coverage assertion in api-playground-openapi-catalog.unit.test.ts
    // enforces the reverse (nothing extra), but this test also pins the union
    // so a stale generator run — where the module has fewer entries than the
    // OpenAPI doc — surfaces here rather than in a browser-only smoke test.
    const configs = buildPrivateChannelsPlaygroundEndpointConfigs(t);
    const ids = new Set(configs.map((endpoint) => endpoint.id));

    expect(ids.has("get-private-channel-instance")).toBe(true);
    expect(ids.has("connect-private-channel-instance")).toBe(true);
    expect(ids.has("list-private-channels")).toBe(true);
    expect(ids.has("list-project-private-channel-events")).toBe(true);
    expect(ids.has("delete-private-channel-verified-wallet")).toBe(true);
  });
});
