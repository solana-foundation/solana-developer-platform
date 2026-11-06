import { projectHref } from "@/lib/dashboard-project-path";

export const API_KEY_FLASH_COOKIE = "sdp_api_key_flash";
export const API_KEYS_PAGE_PATH = "/dashboard/api-keys";
export const API_KEYS_FLASH_PATH = "/dashboard/api-keys/flash";

/**
 * The flash only needs to survive the navigation to the new key's page; keep
 * the window tight.
 */
export const API_KEY_FLASH_MAX_AGE_SECONDS = 120;

/** A freshly generated secret, shown once on the page of the key it belongs to. */
export interface ApiKeyFlash {
  keyId: string;
  key: string;
}

/**
 * Cookie policy for the one-time secret handoff: HttpOnly keeps it away from
 * scripts, Secure keeps it off the wire in production, SameSite=Strict keeps
 * cross-site requests from carrying it, and the path scopes it to the API
 * keys surface.
 */
export function apiKeyFlashCookieOptions(
  projectId: string,
  maxAge: number
): {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: projectHref(projectId, API_KEYS_PAGE_PATH),
    maxAge,
  };
}
