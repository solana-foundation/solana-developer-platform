import { describe, expect, it } from "vitest";
import {
  CUSTODY_PROVIDER_CATALOG,
  providerSupportsStoredCredentialSetup,
} from "./provider-catalog";

describe("providerSupportsStoredCredentialSetup", () => {
  // The connections surface — the list, the detail route, Add connection — is
  // gated on this. Gated on "is a known custody provider" instead, Privy's
  // connections showed up on Fireblocks' page, each row linking into
  // /integrations/fireblocks/connections/<a privy connection>.
  it("is true only where a tenant can install its own credentials here", () => {
    const supported = CUSTODY_PROVIDER_CATALOG.filter((provider) =>
      providerSupportsStoredCredentialSetup(provider.id)
    ).map((provider) => provider.id);

    expect(supported).toEqual(["privy", "fireblocks"]);
  });
});
