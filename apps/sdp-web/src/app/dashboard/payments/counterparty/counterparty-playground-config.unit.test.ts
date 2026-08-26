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

    expect(configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "get-counterparty",
          pathFields: [expect.objectContaining({ label: "{counterpartyId}" })],
        }),
      ])
    );
  });

  it("keeps removed identity fields out of create requests and business responses", () => {
    const messages = getMessages("en");
    const t = (
      key: Parameters<typeof translate<typeof messages>>[1],
      values?: Record<string, string | number>
    ) => translate(messages, key, values);

    const configs = buildCounterpartyPlaygroundEndpointConfigs([], t);

    expect(configs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "create-counterparty",
          bodyFields: [
            expect.objectContaining({ key: "displayName" }),
            expect.objectContaining({ key: "email" }),
            expect.objectContaining({ key: "entityType" }),
            expect.objectContaining({ key: "identity.firstName" }),
            expect.objectContaining({ key: "identity.lastName" }),
            expect.objectContaining({ key: "identity.dateOfBirth" }),
            expect.objectContaining({ key: "externalId" }),
          ],
          expectedResponse: {
            counterparty: expect.not.objectContaining({ identity: expect.anything() }),
          },
        }),
      ])
    );
  });
});
