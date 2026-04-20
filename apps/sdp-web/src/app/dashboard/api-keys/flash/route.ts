import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { API_KEY_FLASH_COOKIE, API_KEYS_PAGE_PATH, type ApiKeyFlash } from "../api-key-flash";

function clearFlashCookie(response: NextResponse) {
  response.cookies.set(API_KEY_FLASH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: API_KEYS_PAGE_PATH,
    maxAge: 0,
  });
}

export async function GET() {
  const jar = await cookies();
  const raw = jar.get(API_KEY_FLASH_COOKIE)?.value;
  let flash: ApiKeyFlash | null = null;

  if (raw) {
    try {
      flash = JSON.parse(raw) as ApiKeyFlash;
    } catch {
      flash = null;
    }
  }

  const response = NextResponse.json({ flash });
  if (raw) {
    clearFlashCookie(response);
  }
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  clearFlashCookie(response);
  return response;
}
