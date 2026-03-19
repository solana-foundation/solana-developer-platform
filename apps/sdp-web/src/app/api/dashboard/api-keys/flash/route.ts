import { NextResponse } from "next/server";

const API_KEY_FLASH_COOKIE = "sdp_api_key_flash";
const API_KEYS_PAGE_PATH = "/dashboard/api-keys";

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(API_KEY_FLASH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: API_KEYS_PAGE_PATH,
    maxAge: 0,
  });
  return response;
}
