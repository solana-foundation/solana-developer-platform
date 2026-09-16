import { ADVANCED_SETTINGS_VERSION } from "@sdp/issuance/capabilities";
import {
  type AssetCategory,
  getAssetTypeRegistryEntry,
  type IssuanceMetadata,
  type SelectedSetting,
  type Token,
} from "@sdp/types";
import { projectPublicMetadata } from "./public-metadata";

type ProfileSourceToken = Pick<
  Token,
  "name" | "description" | "decimals" | "template" | "extensions" | "isFreezable"
>;

function categoryForTemplate(template: Token["template"]): AssetCategory {
  if (template === "stablecoin") {
    return "stablecoin";
  }
  if (template === "tokenized-security" || template === "rwa") {
    return "tokenized_security";
  }
  return "generic";
}

function settingsForToken(token: ProfileSourceToken): Record<string, SelectedSetting> {
  const selected: Record<string, SelectedSetting> = {};
  const extensions = token.extensions;

  if (extensions?.pausable) selected.pauseTransfers = {};
  if (token.isFreezable) selected.freezeAccounts = {};
  if (extensions?.permanentDelegate) selected.permanentDelegate = {};
  if (extensions?.transferFee) {
    selected.transferFee = {
      params: {
        basisPoints: extensions.transferFee.basisPoints,
        maxFee: extensions.transferFee.maxFee,
      },
    };
  }
  if (extensions?.interestBearing) {
    selected.interestBearing = { params: { rate: extensions.interestBearing.rate } };
  }
  if (extensions?.scaledUiAmount) {
    selected.scaledUiAmount = {
      params: { multiplier: extensions.scaledUiAmount.multiplier ?? 1 },
    };
  }
  if (extensions?.transferHook) {
    selected.transferHook = { params: { programId: extensions.transferHook.programId } };
  }
  if (extensions?.nonTransferable) selected.nonTransferable = {};

  return selected;
}

/** Build the minimal editable profile for tokens created through the token API. */
export function buildDefaultAssetProfile(token: ProfileSourceToken) {
  const assetCategory = categoryForTemplate(token.template);
  const assetType = "generic";
  const registryEntry = getAssetTypeRegistryEntry(assetCategory, assetType);
  if (!registryEntry) {
    throw new Error(`Missing asset type registry entry for ${assetCategory}/${assetType}`);
  }

  const issuanceMetadata: IssuanceMetadata = {
    asset: {
      name: token.name,
      ...(token.description ? { description: token.description } : {}),
    },
    chain: { decimals: token.decimals },
  };
  const selectedSettings = settingsForToken(token);
  if (Object.keys(selectedSettings).length > 0) {
    issuanceMetadata.settings = {
      version: ADVANCED_SETTINGS_VERSION,
      selected: selectedSettings,
    };
  }

  return {
    assetCategory,
    assetType,
    assetTypeVersion: registryEntry.version,
    issuanceMetadata,
    publicMetadata: projectPublicMetadata(assetCategory, assetType, issuanceMetadata),
  };
}
