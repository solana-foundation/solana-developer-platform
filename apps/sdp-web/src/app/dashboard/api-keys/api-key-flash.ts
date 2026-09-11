export const API_KEY_FLASH_COOKIE = "sdp_api_key_flash";
export const API_KEYS_PAGE_PATH = "/dashboard/api-keys";
export const API_KEYS_FLASH_PATH = "/dashboard/api-keys/flash";

/**
 * A flash carrying a freshly generated key secret only needs to survive the
 * redirect back to the API keys page; keep the window tight. Plain notices
 * get a little longer.
 */
export const API_KEY_FLASH_SECRET_MAX_AGE_SECONDS = 120;
export const API_KEY_FLASH_NOTICE_MAX_AGE_SECONDS = 300;

export type FlashLevel = "success" | "error";

export interface ApiKeyFlash {
  level: FlashLevel;
  message: string;
  key?: string;
  apiKeyId?: string;
  keyPrefix?: string;
}

export function apiKeyFlashMaxAgeSeconds(flash: ApiKeyFlash): number {
  return flash.key ? API_KEY_FLASH_SECRET_MAX_AGE_SECONDS : API_KEY_FLASH_NOTICE_MAX_AGE_SECONDS;
}

/**
 * Cookie policy for the one-time secret handoff: HttpOnly keeps it away from
 * scripts, Secure keeps it off the wire in production, SameSite=Strict keeps
 * cross-site requests from carrying it, and the path scopes it to the API
 * keys surface.
 */
export function apiKeyFlashCookieOptions(maxAge: number): {
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
    path: API_KEYS_PAGE_PATH,
    maxAge,
  };
}
