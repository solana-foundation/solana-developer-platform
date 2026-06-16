"use server";

import { revalidatePath } from "next/cache";
import { sdpApiRequest } from "@/lib/sdp-api";
import { isValidTokenDecimals } from "./create-token-modal.utils";
import { issuanceTemplateCatalog } from "./template-catalog";

type ActionState = "idle" | "success" | "error";

export interface CreateIssuanceTokenResult {
  state: ActionState;
  message: string | null;
  tokenId: string | null;
  tokenName: string | null;
}

function parseBoolean(value: FormDataEntryValue | null, fallback: boolean): boolean {
  if (typeof value !== "string") {
    return fallback;
  }
  if (value === "true" || value === "on") {
    return true;
  }
  if (value === "false" || value === "off") {
    return false;
  }
  return fallback;
}

function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
    if (parsed?.message) {
      return parsed.message;
    }
  } catch {
    // Fall through to raw body below.
  }

  return body || "Unknown error";
}

/**
 * Validate an optional metadata URI (HOO-466): empty is allowed — SDP hosts the
 * JSON automatically. Returns an error message when a non-empty value is not a
 * valid http(s) URL, or null when the value is acceptable.
 */
function validateOptionalMetadataUri(uri: string): string | null {
  if (!uri) {
    return null;
  }

  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Metadata URI must use http or https.";
    }
  } catch {
    return "Metadata URI must be a valid URL.";
  }

  return null;
}

export async function createIssuanceTokenAction(
  formData: FormData
): Promise<CreateIssuanceTokenResult> {
  const uri = String(formData.get("uri") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const symbol = String(formData.get("symbol") ?? "").trim();
  const template = String(formData.get("template") ?? "custom").trim();
  const description = String(formData.get("description") ?? "").trim();
  const signingWalletId = String(formData.get("signingWalletId") ?? "").trim();
  const decimalsRaw = String(formData.get("decimals") ?? "").trim();
  const maxSupplyRaw = String(formData.get("maxSupply") ?? "").trim();
  const requiresAllowlist = parseBoolean(formData.get("requiresAllowlist"), false);
  const isMintable = parseBoolean(formData.get("isMintable"), true);
  const isFreezable = parseBoolean(formData.get("isFreezable"), true);

  if (!name) {
    return {
      state: "error",
      message: "Token name is required.",
      tokenId: null,
      tokenName: null,
    };
  }

  const uriError = validateOptionalMetadataUri(uri);
  if (uriError) {
    return {
      state: "error",
      message: uriError,
      tokenId: null,
      tokenName: null,
    };
  }

  if (!symbol || !/^[A-Za-z0-9.]{1,10}$/.test(symbol)) {
    return {
      state: "error",
      message: "Symbol must be 1-10 characters using letters, numbers, or periods.",
      tokenId: null,
      tokenName: null,
    };
  }

  if (!issuanceTemplateCatalog.some((entry) => entry.id === template)) {
    return {
      state: "error",
      message: "Invalid template selection.",
      tokenId: null,
      tokenName: null,
    };
  }

  const payload: {
    name: string;
    symbol: string;
    template: string;
    uri?: string;
    signingWalletId?: string;
    description?: string;
    decimals?: number;
    maxSupply?: string;
    requiresAllowlist: boolean;
    isMintable: boolean;
    isFreezable: boolean;
  } = {
    name,
    symbol,
    template,
    requiresAllowlist,
    isMintable,
    isFreezable,
  };

  if (uri) {
    payload.uri = uri;
  }

  if (description) {
    payload.description = description;
  }

  if (signingWalletId) {
    payload.signingWalletId = signingWalletId;
  }

  if (decimalsRaw) {
    if (!isValidTokenDecimals(decimalsRaw)) {
      return {
        state: "error",
        message: "Decimals must be between 0 and 18.",
        tokenId: null,
        tokenName: null,
      };
    }

    const parsed = Number.parseInt(decimalsRaw, 10);
    payload.decimals = parsed;
  }

  if (maxSupplyRaw) {
    payload.maxSupply = maxSupplyRaw;
  }

  try {
    const response = await sdpApiRequest("/v1/issuance/tokens", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        state: "error",
        message: `Create failed (${response.status}): ${parseErrorMessage(body)}`,
        tokenId: null,
        tokenName: null,
      };
    }

    const json = (await response.json()) as {
      data?: {
        token?: {
          id?: string;
          name?: string;
        };
      };
    };

    const tokenId = json?.data?.token?.id ?? null;
    const tokenName = json?.data?.token?.name ?? name;

    revalidatePath("/dashboard/issuance");

    return {
      state: "success",
      message: `Draft ${tokenName} created. Deploy it on-chain from the token page.`,
      tokenId,
      tokenName,
    };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Unexpected error",
      tokenId: null,
      tokenName: null,
    };
  }
}
