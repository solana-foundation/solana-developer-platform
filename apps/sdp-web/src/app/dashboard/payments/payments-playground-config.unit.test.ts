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

  it("uses exact wallet identity only for the Transfer contract", () => {
    const messages = getMessages("en");
    const t = (
      key: Parameters<typeof translate<typeof messages>>[1],
      values?: Record<string, string | number>
    ) => translate(messages, key, values);
    const configs = buildPaymentsPlaygroundEndpointConfigs(
      {
        transfers: [],
        wallets: [{ id: "cwlt_1", walletId: "privy_1", publicKey: "address_1", label: "Treasury" }],
      },
      t
    );

    const execute = configs.find(({ id }) => id === "execute-transfer");
    const onramp = configs.find(({ id }) => id === "create-onramp-quote");
    const offramp = configs.find(({ id }) => id === "create-offramp-quote");

    expect(execute?.bodyFields.find(({ key }) => key === "sourceCustodyWalletId")).toMatchObject({
      defaultValue: "cwlt_1",
    });
    expect(execute?.bodyFields.some(({ key }) => key === "source")).toBe(false);
    expect(onramp?.bodyFields.find(({ key }) => key === "destinationWallet")).toMatchObject({
      defaultValue: "privy_1",
    });
    expect(offramp?.bodyFields.find(({ key }) => key === "sourceWallet")).toMatchObject({
      defaultValue: "privy_1",
    });
  });
});
