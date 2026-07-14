import { describe, expect, it } from "vitest";
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

    expect(configs.find(({ id }) => id === "get-counterparty")?.pathFields[0]?.label).toBe(
      "{counterpartyId}"
    );
  });
});
