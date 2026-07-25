import { describe, expect, it } from "vitest";

import { buildWalletsPlaygroundEndpointConfigs } from "@/app/dashboard/custody/wallets-playground-config";
import { buildIssuancePlaygroundEndpointConfigs } from "@/app/dashboard/issuance/issuance-playground-config";
import { buildCounterpartyPlaygroundEndpointConfigs } from "@/app/dashboard/payments/counterparty/counterparty-playground-config";
import { buildPaymentsPlaygroundEndpointConfigs } from "@/app/dashboard/payments/payments-playground-config";
import type { ApiPlaygroundEndpointConfig } from "@/components/api-playground-shell";
import { getMessages, translate } from "@/i18n/messages";
import { getOpenApiPlaygroundEndpoints } from "./api-playground-openapi-catalog";

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
