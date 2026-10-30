import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { translate } from "@/i18n/translate";
import { getOpenApiPlaygroundEndpoints } from "@/lib/api-playground-openapi-catalog";
import { buildPaymentsPlaygroundEndpointConfigs } from "./payments-playground-config";

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

describe("buildPaymentsPlaygroundEndpointConfigs", () => {
  it.each([
    {
      wallets: [{ id: "cwlt_selected", publicKey: "address_selected", label: "Treasury" }],
      expectedDefault: "cwlt_selected",
    },
    { wallets: [], expectedDefault: undefined },
  ])("uses the OpenAPI balance example with wallet $expectedDefault", (example) => {
    const configs = buildPaymentsPlaygroundEndpointConfigs(
      { transfers: [], wallets: example.wallets, rampProviders: [] },
      t
    );
    const endpoint = configs.find(({ id }) => id === "wallet-balances");
    const openApiEndpoint = getOpenApiPlaygroundEndpoints("payments").find(
      ({ id }) => id === "get-payment-wallet-balances"
    );

    expect(endpoint?.pathFields[0]?.defaultValue).toBe(example.expectedDefault);
    expect(openApiEndpoint).toBeDefined();
    expect(endpoint?.expectedResponse).toEqual(openApiEndpoint?.expectedResponse);
    expect(endpoint?.expectedResponse).toHaveProperty(
      "data.walletBalances.custodyWalletId",
      "cwlt_example"
    );
    expect(endpoint?.expectedResponse).not.toHaveProperty("data.walletBalances.walletId");
    expect(endpoint?.expectedResponse).not.toHaveProperty("data.walletId");
  });

  it("offers only the ramp providers the flags leave on, in the quote endpoints' provider picker", () => {
    const configs = buildPaymentsPlaygroundEndpointConfigs(
      { transfers: [], wallets: [], rampProviders: ["moonpay", "stripe"] },
      t
    );

    for (const endpointId of ["create-onramp-quote", "create-offramp-quote"]) {
      const field = providerField(configs, endpointId);
      expect(field?.kind).toBe("select");
      expect(field?.options?.map((option) => option.value)).toEqual(["moonpay", "stripe"]);
      expect(field?.options?.map((option) => option.label)).toEqual(["MoonPay", "Stripe"]);
      expect(field?.defaultValue).toBe("moonpay");
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
