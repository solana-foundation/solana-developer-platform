import { describe, expect, it } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { buildPaymentsPlaygroundEndpointConfigs } from "./payments-playground-config.redesign";

const messages = getMessages("en");
const t = (
  key: Parameters<typeof translate<typeof messages>>[1],
  values?: Record<string, string | number>
) => translate(messages, key, values);

function providerField(
  configs: ReturnType<typeof buildPaymentsPlaygroundEndpointConfigs>,
  endpointId: string
) {
  return configs
    .find(({ id }) => id === endpointId)
    ?.bodyFields?.find((field) => field.key === "provider");
}

describe("buildPaymentsPlaygroundEndpointConfigs (NEW DESIGN)", () => {
  it("offers only the ramp providers the flags leave on, in the quote endpoints' provider picker", () => {
    const configs = buildPaymentsPlaygroundEndpointConfigs(
      { transfers: [], wallets: [], rampProviders: ["bvnk", "coinbase"] },
      t
    );

    for (const endpointId of ["create-onramp-quote", "create-offramp-quote"]) {
      const field = providerField(configs, endpointId);
      expect(field?.kind).toBe("select");
      expect(field?.options?.map((option) => option.value)).toEqual(["bvnk", "coinbase"]);
      expect(field?.options?.map((option) => option.label)).toEqual(["BVNK", "Coinbase"]);
      expect(field?.defaultValue).toBe("bvnk");
    }
  });

  it("leaves the provider as a typed field when the channel offers no ramp provider", () => {
    const configs = buildPaymentsPlaygroundEndpointConfigs(
      { transfers: [], wallets: [], rampProviders: [] },
      t
    );

    const field = providerField(configs, "create-onramp-quote");
    expect(field?.kind).toBeUndefined();
    expect(field?.options).toBeUndefined();
    expect(field?.required).toBe(true);
  });
});
