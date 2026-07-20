import { ADVANCED_SETTINGS_VERSION } from "@sdp/issuance/capabilities";
import type { IssuanceMetadata } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  getSelectedSettings,
  resolveAdvancedSettings,
  stampAdvancedSettingsVersion,
  validateAdvancedSettings,
} from "./advanced-settings";

describe("advanced settings persistence helpers", () => {
  describe("validateAdvancedSettings", () => {
    it("accepts settings allowed for the asset type", () => {
      const metadata: IssuanceMetadata = {
        settings: { selected: { freezeTransfers: {}, permanentDelegate: {} } },
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

    it("rejects an out-of-range numeric param on an otherwise-supported setting", () => {
      // transferFee is allowed for generic assets, so the key check passes; the
      // catalog bound (basisPoints ∈ [0, 10_000]) is what rejects 99999. This is
      // the hole a crafted payload would otherwise use — the client min/max is
      // advisory only.
      const metadata: IssuanceMetadata = {
        settings: { selected: { transferFee: { params: { basisPoints: 99999 } } } },
      };
      expect(validateAdvancedSettings("generic", "generic", metadata)).toEqual([
        { settingKey: "transferFee", paramKey: "basisPoints", reason: "above_max", limit: 10_000 },
      ]);
    });

    it("accepts an in-range numeric param", () => {
      const metadata: IssuanceMetadata = {
        settings: { selected: { transferFee: { params: { basisPoints: 250, maxFee: "0" } } } },
      };
      expect(validateAdvancedSettings("generic", "generic", metadata)).toEqual([]);
    });

    it("does not re-flag params of a setting already rejected at the key level", () => {
      // transferFee is unsupported on a stablecoin: report the key once, and skip
      // its param bounds rather than piling on a second (redundant) error.
      const metadata: IssuanceMetadata = {
        settings: { selected: { transferFee: { params: { basisPoints: 99999 } } } },
      };
      expect(validateAdvancedSettings("stablecoin", "fiat_backed", metadata)).toEqual([
        { settingKey: "transferFee", reason: "unsupported" },
      ]);
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

  describe("getSelectedSettings", () => {
    it("returns the selected settings map", () => {
      const metadata: IssuanceMetadata = {
        settings: { selected: { freezeTransfers: {}, permanentDelegate: {} } },
      };
      expect(getSelectedSettings(metadata)).toEqual({ freezeTransfers: {}, permanentDelegate: {} });
    });

    it("returns an empty object when there is no selection", () => {
      expect(getSelectedSettings({ asset: { name: "X" } })).toEqual({});
      expect(getSelectedSettings({})).toEqual({});
    });
  });

  describe("resolveAdvancedSettings", () => {
    it("returns no errors when the selection builds against the template", () => {
      const metadata: IssuanceMetadata = { settings: { selected: { freezeTransfers: {} } } };
      expect(resolveAdvancedSettings("stablecoin", "fiat_backed", metadata)).toEqual([]);
    });

    it("returns no errors when there is no settings namespace", () => {
      expect(resolveAdvancedSettings("generic", "generic", { asset: { name: "X" } })).toEqual([]);
    });

    it("surfaces a template error for a selection the substrate can't build", () => {
      // transferFee bypassing the capability check → the stablecoin template rejects it.
      const metadata: IssuanceMetadata = {
        settings: { selected: { transferFee: { params: { basisPoints: 10, maxFee: "1" } } } },
      };
      const errors = resolveAdvancedSettings("stablecoin", "fiat_backed", metadata);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].code).toBe("EXTENSION_NOT_ALLOWED");
    });
  });
});
