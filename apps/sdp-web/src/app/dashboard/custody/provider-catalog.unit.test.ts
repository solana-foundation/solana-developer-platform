import { describe, expect, it } from "vitest";
import {
  CUSTODY_PROVIDER_CATALOG,
  CUSTODY_PROVIDER_DISPLAY_STATUSES,
  getCustodyProviderEntry,
} from "./provider-catalog";

describe("custody provider catalog", () => {
  it("publishes the complete provider display status vocabulary", () => {
    expect(CUSTODY_PROVIDER_DISPLAY_STATUSES).toEqual([
      "available",
      "active",
      "request_access",
      "not_configured",
    ]);
  });

  it("publishes every provider with its launch classification and setup mode", () => {
    expect(
      CUSTODY_PROVIDER_CATALOG.map((provider) => ({
        id: provider.id,
        visible: provider.visible,
        availability: provider.availability,
        mode: provider.storedCredentialSetup.mode,
      }))
    ).toEqual([
      // The launch classification from the remove-signup-waitlist decision map.
      // Fireblocks is the only provider with an established request route;
      // routes for the other manual providers are HOO-775.
      { id: "local", visible: true, availability: "general", mode: "none" },
      { id: "privy", visible: true, availability: "general", mode: "self_service" },
      { id: "fireblocks", visible: true, availability: "manual", mode: "request_access" },
      { id: "coinbase_cdp", visible: true, availability: "general", mode: "none" },
      { id: "para", visible: true, availability: "general", mode: "none" },
      { id: "turnkey", visible: true, availability: "general", mode: "none" },
      { id: "dfns", visible: true, availability: "manual", mode: "none" },
      { id: "ibm_haven", visible: true, availability: "manual", mode: "none" },
      { id: "anchorage", visible: true, availability: "manual", mode: "none" },
      { id: "utila", visible: true, availability: "manual", mode: "none" },
    ]);
  });

  it("describes the complete Privy self-service form without credential values", () => {
    expect(getCustodyProviderEntry("privy").storedCredentialSetup).toEqual({
      mode: "self_service",
      fields: [
        {
          key: "credentialLabel",
          labelKey: "DashboardCustody.providerCredentialLabel",
          helpTextKey: "DashboardCustody.providerCredentialLabelDescription",
          kind: "text",
          required: true,
          defaultValue: "Privy credential",
          valueHandling: "plain",
        },
        {
          key: "scope",
          labelKey: "DashboardCustody.providerCredentialScope",
          helpTextKey: "DashboardCustody.providerCredentialScopeDescription",
          kind: "select",
          required: true,
          defaultValue: "organization",
          options: [
            {
              value: "organization",
              labelKey: "DashboardCustody.providerCredentialScopeOrganization",
            },
            {
              value: "project",
              labelKey: "DashboardCustody.providerCredentialScopeProject",
            },
          ],
          valueHandling: "plain",
        },
        {
          key: "appId",
          labelKey: "DashboardCustody.providerPrivyAppId",
          helpTextKey: "DashboardCustody.providerPrivyAppIdDescription",
          kind: "text",
          required: true,
          valueHandling: "redacted_metadata",
          redactionKind: "suffix",
        },
        {
          key: "appSecret",
          labelKey: "DashboardCustody.providerPrivyAppSecret",
          helpTextKey: "DashboardCustody.providerPrivyAppSecretDescription",
          kind: "password",
          required: true,
          valueHandling: "secret",
        },
      ],
    });
  });
});
