import { ADVANCED_SETTINGS_VERSION } from "@sdp/issuance/capabilities";
import type { IssuanceMetadata } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { stampAdvancedSettingsVersion, validateAdvancedSettings } from "./advanced-settings";

describe("advanced settings persistence helpers", () => {
  describe("validateAdvancedSettings", () => {
    it("accepts settings allowed for the asset type", () => {
      const metadata: IssuanceMetadata = {
        settings: {
          selected: { freezeTransfers: {}, transferFee: { params: { basisPoints: 50 } } },
        },
      };
      expect(validateAdvancedSettings("stablecoin", "fiat_backed", metadata)).toEqual([]);
    });

    it("rejects an unsupported setting for the asset type", () => {
      const metadata: IssuanceMetadata = {
        settings: { selected: { nonTransferable: {} } },
      };
      expect(validateAdvancedSettings("stablecoin", "fiat_backed", metadata)).toEqual([
        { settingKey: "nonTransferable", reason: "unsupported" },
      ]);
    });

    it("rejects an unknown setting key", () => {
      const metadata: IssuanceMetadata = { settings: { selected: { made_up: {} } } };
      expect(validateAdvancedSettings("generic", "generic", metadata)).toEqual([
        { settingKey: "made_up", reason: "unknown" },
      ]);
    });

    it("returns no errors when there is no settings namespace", () => {
      expect(validateAdvancedSettings("generic", "generic", { asset: { name: "X" } })).toEqual([]);
      expect(validateAdvancedSettings("generic", "generic", {})).toEqual([]);
    });
  });

  describe("stampAdvancedSettingsVersion", () => {
    it("stamps the server version onto a selection", () => {
      const metadata: IssuanceMetadata = { settings: { selected: { freezeTransfers: {} } } };
      const stamped = stampAdvancedSettingsVersion(metadata);
      expect((stamped.settings as { version: number }).version).toBe(ADVANCED_SETTINGS_VERSION);
      // input is not mutated
      expect((metadata.settings as { version?: number }).version).toBeUndefined();
    });

    it("overwrites a client-supplied version with the server version", () => {
      const metadata: IssuanceMetadata = {
        settings: { version: 999, selected: { freezeTransfers: {} } },
      };
      const stamped = stampAdvancedSettingsVersion(metadata);
      expect((stamped.settings as { version: number }).version).toBe(ADVANCED_SETTINGS_VERSION);
    });

    it("is a no-op when there is no settings selection", () => {
      const metadata: IssuanceMetadata = { asset: { name: "X" } };
      expect(stampAdvancedSettingsVersion(metadata)).toBe(metadata);
    });
  });
});
