export const API_KEY_FLASH_COOKIE = "sdp_api_key_flash";
export const API_KEYS_PAGE_PATH = "/dashboard/api-keys";
export const API_KEYS_FLASH_PATH = "/dashboard/api-keys/flash";

export type FlashLevel = "success" | "error";

export interface ApiKeyFlash {
  level: FlashLevel;
  message: string;
  key?: string;
  apiKeyId?: string;
  keyPrefix?: string;
}
