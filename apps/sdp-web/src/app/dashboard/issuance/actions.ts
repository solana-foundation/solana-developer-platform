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

  if (!uri) {
    return {
      state: "error",
      message: "Metadata URI is required.",
      tokenId: null,
      tokenName: null,
    };
  }

  try {
    const parsedUri = new URL(uri);
    if (parsedUri.protocol !== "http:" && parsedUri.protocol !== "https:") {
      return {
        state: "error",
        message: "Metadata URI must use http or https.",
        tokenId: null,
        tokenName: null,
      };
    }
  } catch {
    return {
      state: "error",
      message: "Metadata URI must be a valid URL.",
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
    uri: string;
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
    uri,
    requiresAllowlist,
    isMintable,
    isFreezable,
  };

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
