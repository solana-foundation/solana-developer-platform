import { describe, expect, it } from "vitest";

import { buildWalletsPlaygroundEndpointConfigs } from "@/app/dashboard/[projectId]/custody/wallets-playground-config";
import { buildIssuancePlaygroundEndpointConfigs } from "@/app/dashboard/[projectId]/issuance/issuance-playground-config";
import { buildCounterpartyPlaygroundEndpointConfigs } from "@/app/dashboard/[projectId]/payments/counterparty/counterparty-playground-config";
import { buildPaymentsPlaygroundEndpointConfigs } from "@/app/dashboard/[projectId]/payments/payments-playground-config";
import type { ApiPlaygroundEndpointConfig } from "@/components/api-playground-shell";
import { getMessages } from "@/i18n/messages";
import { translate } from "@/i18n/translate";
import {
  filterPlaygroundEndpointsToReleaseChannel,
  getOpenApiPlaygroundEndpoints,
} from "./api-playground-openapi-catalog";

function operationKey(endpoint: ApiPlaygroundEndpointConfig): string {
  return `${endpoint.method} ${endpoint.path.split("?", 1)[0]}`;
}

describe("API playground module coverage", () => {
  it("exposes every public operation only through its owning product builder", () => {
    const messages = getMessages("en");
    const t = (
      key: Parameters<typeof translate<typeof messages>>[1],
      values?: Record<string, string | number>
    ) => translate(messages, key, values);
    const configsByModule = {
      wallets: buildWalletsPlaygroundEndpointConfigs({
        connectedProviders: [],
        wallets: [],
        t,
      }),
      payments: buildPaymentsPlaygroundEndpointConfigs({ transfers: [], wallets: [] }, t),
      counterparties: buildCounterpartyPlaygroundEndpointConfigs([], t),
      issuance: buildIssuancePlaygroundEndpointConfigs({ templates: [], tokens: [], t }),
    };

    for (const [module, configs] of Object.entries(configsByModule)) {
      const configuredKeys = new Set(configs.map(operationKey));
      const publicKeys = getOpenApiPlaygroundEndpoints(module as keyof typeof configsByModule).map(
        operationKey
      );

      expect(configuredKeys.size).toBe(configs.length);
      expect(publicKeys.every((key) => configuredKeys.has(key))).toBe(true);
      for (const [otherModule, otherConfigs] of Object.entries(configsByModule)) {
        if (otherModule !== module) {
          const otherKeys = new Set(otherConfigs.map(operationKey));
          expect(publicKeys.some((key) => otherKeys.has(key))).toBe(false);
        }
      }
    }
  });
});

describe("API playground release channel", () => {
  const messages = getMessages("en");
  const t = (
    key: Parameters<typeof translate<typeof messages>>[1],
    values?: Record<string, string | number>
  ) => translate(messages, key, values);
  const paths = (endpoints: ApiPlaygroundEndpointConfig[]) =>
    endpoints.map((endpoint) => endpoint.path.split("?", 1)[0]);

  it("offers no ramp form, curated or generated, on a stable deployment", () => {
    const payments = buildPaymentsPlaygroundEndpointConfigs({ transfers: [], wallets: [] }, t);
    expect(paths(payments)).toContain("/v1/payments/ramps/onramp/quote");

    const stable = paths(filterPlaygroundEndpointsToReleaseChannel(payments, "stable"));
    expect(stable.filter((path) => path.startsWith("/v1/payments/ramps"))).toEqual([]);
    expect(stable).toContain("/v1/payments/transfers");
    expect(stable).toContain("/v1/payments/recurring-payments");
  });

  it("drops counterparty ramp onboarding and every issuance form on a stable deployment", () => {
    const counterparties = filterPlaygroundEndpointsToReleaseChannel(
      buildCounterpartyPlaygroundEndpointConfigs([], t),
      "stable"
    );
    expect(
      paths(counterparties).filter((path) => /requirements|provider-accounts/.test(path))
    ).toEqual([]);
    expect(paths(counterparties)).toContain("/v1/counterparties");

    const issuance = buildIssuancePlaygroundEndpointConfigs({ templates: [], tokens: [], t });
    expect(issuance.length).toBeGreaterThan(0);
    expect(filterPlaygroundEndpointsToReleaseChannel(issuance, "stable")).toEqual([]);
  });

  it("offers no module the stable channel leaves out in a kept endpoint's fields", () => {
    const transactions = filterPlaygroundEndpointsToReleaseChannel(
      getOpenApiPlaygroundEndpoints("payments"),
      "stable"
    ).find((endpoint) => endpoint.id === "list-unified-transactions");
    const modulePicker = transactions?.pathFields.find((field) => field.key === "module");
    expect(modulePicker?.options?.map((option) => option.value)).toEqual(["payments"]);
    expect(JSON.stringify(transactions?.expectedResponse)).not.toMatch(/"(issuance|dvp|rings)"/);
  });

  it("prunes values, not the objects that hold them, and drops selects left empty", () => {
    const payments = filterPlaygroundEndpointsToReleaseChannel(
      getOpenApiPlaygroundEndpoints("payments"),
      "stable"
    );
    const batches = payments.find((endpoint) => endpoint.id === "create-payment-transfer-batch");
    expect(JSON.stringify(batches?.expectedResponse)).toMatch(/"transfers":\[\{/);
    expect(JSON.stringify(batches?.expectedResponse)).not.toMatch(/moonpay|stripe/);

    const transfers = payments.find((endpoint) => endpoint.id === "list-payment-transfers");
    expect(transfers?.pathFields.map((field) => field.key)).not.toContain("provider");

    const wallet = filterPlaygroundEndpointsToReleaseChannel(
      getOpenApiPlaygroundEndpoints("wallets"),
      "stable"
    ).find((endpoint) => endpoint.id === "create-wallet");
    const body = wallet?.bodyFields.find((field) => field.key === "$body")?.defaultValue ?? "";
    expect(body).not.toMatch(/mint_authority/);
    expect(JSON.parse(body)).toMatchObject({ provider: expect.any(String) });
  });

  it("filters every playground's forms on every channel without rejecting their examples", () => {
    const builders = [
      buildWalletsPlaygroundEndpointConfigs({ connectedProviders: [], wallets: [], t }),
      buildPaymentsPlaygroundEndpointConfigs({ transfers: [], wallets: [] }, t),
      buildCounterpartyPlaygroundEndpointConfigs([], t),
      buildIssuancePlaygroundEndpointConfigs({ templates: [], tokens: [], t }),
    ];
    for (const releaseChannel of ["experimental", "beta", "stable"] as const) {
      for (const endpoints of builders) {
        expect(() =>
          filterPlaygroundEndpointsToReleaseChannel(endpoints, releaseChannel)
        ).not.toThrow();
      }
    }
  });

  it("keeps every catalog operation on an experimental deployment", () => {
    for (const module of ["wallets", "payments", "counterparties", "issuance"] as const) {
      const endpoints = getOpenApiPlaygroundEndpoints(module);
      expect(
        filterPlaygroundEndpointsToReleaseChannel(endpoints, "experimental").map(
          (endpoint) => endpoint.id
        )
      ).toEqual(endpoints.map((endpoint) => endpoint.id));
    }
  });
});
