import { assert, describe, expect, it } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { buildCounterpartyPlaygroundEndpointConfigs } from "./counterparty-playground-config";

describe("buildCounterpartyPlaygroundEndpointConfigs", () => {
  it.each([
    ["without loaded counterparties", []],
    ["with a loaded counterparty", [{ id: "cpty_123", displayName: "Acme Corp" }]],
  ])("builds literal path field labels %s", (_scenario, counterparties) => {
    const messages = getMessages("en");
    const t = (
      key: Parameters<typeof translate<typeof messages>>[1],
      values?: Record<string, string | number>
    ) => translate(messages, key, values);

    const configs = buildCounterpartyPlaygroundEndpointConfigs(counterparties, t);

    const config = configs.find(({ id }) => id === "get-counterparty");
    assert(config);
    const pathField = config.pathFields[0];
    assert(pathField);
    expect(pathField.label).toBe("{counterpartyId}");
  });

  it("curates only the stored counterparty fields for create and update", () => {
    const messages = getMessages("en");
    const t = (
      key: Parameters<typeof translate<typeof messages>>[1],
      values?: Record<string, string | number>
    ) => translate(messages, key, values);

    const configs = buildCounterpartyPlaygroundEndpointConfigs([], t);
    const createConfig = configs.find(({ id }) => id === "create-counterparty");
    const updateConfig = configs.find(({ id }) => id === "update-counterparty");
    assert(createConfig);
    assert(updateConfig);

    expect(createConfig.bodyFields.map(({ key }) => key)).toEqual([
      "displayName",
      "entityType",
      "externalId",
    ]);
    expect(updateConfig.bodyFields.map(({ key }) => key)).toEqual([
      "displayName",
      "entityType",
      "externalId",
    ]);
  });
});
