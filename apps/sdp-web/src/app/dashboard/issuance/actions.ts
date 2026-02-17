"use server";

import { sdpApiRequest } from "@/lib/sdp-api";
import { revalidatePath } from "next/cache";
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
  const name = String(formData.get("name") ?? "").trim();
  const symbol = String(formData.get("symbol") ?? "")
    .trim()
    .toUpperCase();
  const template = String(formData.get("template") ?? "custom").trim();
  const description = String(formData.get("description") ?? "").trim();
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

  if (!symbol || !/^[A-Z0-9]{1,10}$/.test(symbol)) {
    return {
      state: "error",
      message: "Symbol must be 1-10 characters, uppercase letters or numbers.",
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

  if (description) {
    payload.description = description;
  }

  if (decimalsRaw) {
    const parsed = Number.parseInt(decimalsRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 18) {
      return {
        state: "error",
        message: "Decimals must be between 0 and 18.",
        tokenId: null,
        tokenName: null,
      };
    }
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
      message: `Token ${tokenName} created successfully.`,
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
