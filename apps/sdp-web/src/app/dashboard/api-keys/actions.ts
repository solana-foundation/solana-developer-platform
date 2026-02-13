"use server";

import { sdpApiFetch } from "@/lib/sdp-api";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const API_KEY_FLASH_COOKIE = "sdp_api_key_flash";
const API_KEYS_PAGE_PATH = "/dashboard/api-keys";

type FlashLevel = "success" | "error";

interface ApiKeyFlash {
  level: FlashLevel;
  message: string;
  key?: string;
  keyPrefix?: string;
}

function parsePositiveInt(value: FormDataEntryValue | null, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function setFlash(flash: ApiKeyFlash) {
  const jar = await cookies();
  jar.set(API_KEY_FLASH_COOKIE, JSON.stringify(flash), {
    httpOnly: true,
    sameSite: "lax",
    path: API_KEYS_PAGE_PATH,
    maxAge: 60 * 5,
  });
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

export async function consumeApiKeyFlash(): Promise<ApiKeyFlash | null> {
  const jar = await cookies();
  const raw = jar.get(API_KEY_FLASH_COOKIE)?.value;
  if (!raw) return null;

  jar.delete(API_KEY_FLASH_COOKIE);

  try {
    return JSON.parse(raw) as ApiKeyFlash;
  } catch {
    return null;
  }
}

export async function createApiKeyAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "api_developer");
  const environment = String(formData.get("environment") ?? "sandbox");
  const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();

  if (!name) {
    await setFlash({
      level: "error",
      message: "API key name is required.",
    });
    redirect(API_KEYS_PAGE_PATH);
  }

  const payload: {
    name: string;
    role: "api_admin" | "api_developer" | "api_readonly";
    environment: "sandbox" | "production";
    expiresAt?: string;
  } = {
    name,
    role:
      role === "api_admin" || role === "api_readonly" || role === "api_developer"
        ? role
        : "api_developer",
    environment: environment === "production" ? "production" : "sandbox",
  };

  if (expiresAtRaw) {
    const parsedDate = new Date(expiresAtRaw);
    if (Number.isNaN(parsedDate.getTime())) {
      await setFlash({
        level: "error",
        message: "Invalid expiration date.",
      });
      redirect(API_KEYS_PAGE_PATH);
    }
    payload.expiresAt = parsedDate.toISOString();
  }

  try {
    const response = await sdpApiFetch<{
      apiKey: {
        id: string;
        name: string;
        key: string;
        keyPrefix: string;
      };
    }>("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    await setFlash({
      level: "success",
      message: `API key "${response.apiKey.name}" created. Save it now; it will not be shown again.`,
      key: response.apiKey.key,
      keyPrefix: response.apiKey.keyPrefix,
    });
  } catch (error) {
    await setFlash({
      level: "error",
      message: `Create failed: ${extractErrorMessage(error)}`,
    });
  }

  revalidatePath(API_KEYS_PAGE_PATH);
  redirect(API_KEYS_PAGE_PATH);
}

export async function rotateApiKeyAction(formData: FormData) {
  const keyId = String(formData.get("keyId") ?? "").trim();
  const gracePeriodHours = Math.min(168, Math.max(0, parsePositiveInt(formData.get("grace"), 24)));

  if (!keyId) {
    await setFlash({
      level: "error",
      message: "Missing API key id for rotation.",
    });
    redirect(API_KEYS_PAGE_PATH);
  }

  try {
    const response = await sdpApiFetch<{
      apiKey: {
        id: string;
        name: string;
        key: string;
        keyPrefix: string;
      };
      previousKey: {
        id: string;
        rotationDeadline: string;
      };
    }>(`/v1/api-keys/${keyId}/rotate`, {
      method: "POST",
      body: JSON.stringify({ gracePeriodHours }),
    });

    await setFlash({
      level: "success",
      message: `API key rotated. Previous key remains valid until ${new Date(response.previousKey.rotationDeadline).toLocaleString()}.`,
      key: response.apiKey.key,
      keyPrefix: response.apiKey.keyPrefix,
    });
  } catch (error) {
    await setFlash({
      level: "error",
      message: `Rotate failed: ${extractErrorMessage(error)}`,
    });
  }

  revalidatePath(API_KEYS_PAGE_PATH);
  redirect(API_KEYS_PAGE_PATH);
}
