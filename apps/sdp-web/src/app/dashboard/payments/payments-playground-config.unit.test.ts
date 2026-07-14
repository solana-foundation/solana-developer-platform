import { describe, expect, it } from "vitest";
import { getMessages, translate } from "@/i18n/messages";
import { buildPaymentsPlaygroundEndpointConfigs } from "./payments-playground-config";

describe("buildPaymentsPlaygroundEndpointConfigs", () => {
  it("builds literal path field labels without missing interpolation values", () => {
    const messages = getMessages("en");
    const t = (
      key: Parameters<typeof translate<typeof messages>>[1],
      values?: Record<string, string | number>
    ) => translate(messages, key, values);

    const configs = buildPaymentsPlaygroundEndpointConfigs({ transfers: [], wallets: [] }, t);

    expect(configs.find(({ id }) => id === "wallet-balances")?.pathFields[0]?.label).toBe(
      "{walletId}"
    );
    expect(configs.find(({ id }) => id === "get-transfer")?.pathFields[0]?.label).toBe(
      "{transferId}"
    );
  });
});
