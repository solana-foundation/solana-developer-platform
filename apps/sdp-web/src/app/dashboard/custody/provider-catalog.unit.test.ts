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
      "pending",
      "request_access",
      "unavailable",
    ]);
  });

  it("publishes every existing provider with its stored-credential setup mode", () => {
    expect(
      CUSTODY_PROVIDER_CATALOG.map((provider) => ({
        id: provider.id,
        visible: provider.visible,
        mode: provider.storedCredentialSetup.mode,
      }))
    ).toEqual([
      { id: "local", visible: true, mode: "unavailable" },
      { id: "privy", visible: true, mode: "self_service" },
      { id: "fireblocks", visible: true, mode: "request_access" },
      { id: "coinbase_cdp", visible: true, mode: "unavailable" },
      { id: "para", visible: true, mode: "unavailable" },
      { id: "turnkey", visible: true, mode: "unavailable" },
      { id: "dfns", visible: true, mode: "unavailable" },
      { id: "ibm_haven", visible: true, mode: "unavailable" },
      { id: "anchorage", visible: true, mode: "unavailable" },
      { id: "utila", visible: true, mode: "unavailable" },
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
