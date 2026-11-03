import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { translate } from "@/i18n/translate";
import { grantModuleDescription } from "./api-key-grant-labels";

const messages = getMessages("en");
const t = (key: Parameters<typeof translate<typeof messages>>[1]) => translate(messages, key);

describe("grantModuleDescription", () => {
  // Stable offers no Ramps, so a key there can never submit provider requirements.
  it("names provider requirements on Counterparties only where Ramps is offered", () => {
    expect(grantModuleDescription("counterparties", t, ["counterparties.execute"])).toBe(
      "Counterparties and their accounts. Execute changes payout destinations."
    );
    expect(
      grantModuleDescription("counterparties", t, ["counterparties.execute", "onramp.read"])
    ).toMatch(/submits provider requirements/);
    expect(grantModuleDescription("transfers", t, ["transfers.read"])).toBe(
      "Single transfers from a custody wallet."
    );
  });
});
