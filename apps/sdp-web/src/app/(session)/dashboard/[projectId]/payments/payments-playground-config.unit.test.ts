import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { translate } from "@/i18n/translate";
import {
  buildPaymentsPlaygroundEndpointConfigs,
  mergePaymentsPlaygroundSections,
} from "./payments-playground-config";
import { buildPaymentRequestsPlaygroundEndpointConfigs } from "./requests/payment-requests-playground-config";

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

describe("mergePaymentsPlaygroundSections", () => {
  const wallets = [
    {
      id: "cwlt_1",
      walletId: "privy_1",
      publicKey: "EXAMPLE_WALLET_ADDRESS",
      label: "Ops",
      isRuntimeExecutionAllowed: true,
    },
  ];
  const groups = { payments: "Payments", contacts: "Contacts", requests: "Requests" };

  function merge() {
    return mergePaymentsPlaygroundSections(
      {
        payments: buildPaymentsPlaygroundEndpointConfigs(
          { transfers: [], wallets, rampProviders: [] },
          t
        ),
        contacts: [],
        requests: buildPaymentRequestsPlaygroundEndpointConfigs(
          wallets,
          [{ mintAddress: "EXAMPLE_TOKEN_MINT", symbol: "USDC" }],
          t
        ),
      },
      groups
    );
  }

  it("keeps the hand-written payment request forms over the generated catalog entries", () => {
    const create = merge().find(({ id }) => id === "create-payment-request");
    const walletField = create?.bodyFields?.find((field) => field.key === "walletId");
    expect(walletField?.kind).toBe("select");
    expect(walletField?.defaultValue).toBe("privy_1");
  });

  it("puts every payment request operation in the requests group, once", () => {
    const endpoints = merge();
    const requestEndpoints = endpoints.filter(({ path }) =>
      path.startsWith("/v1/payments/requests")
    );
    expect(requestEndpoints.map(({ id }) => id).sort()).toEqual([
      "cancel-payment-request",
      "create-payment-request",
      "get-payment-request",
      "get-payment-request-link",
      "list-payment-requests",
    ]);
    expect(new Set(requestEndpoints.map(({ group }) => group))).toEqual(new Set(["Requests"]));
    expect(new Set(endpoints.map(({ id }) => id)).size).toBe(endpoints.length);
  });
});
