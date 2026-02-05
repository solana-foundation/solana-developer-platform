import { NextResponse } from "next/server";
import { linkOrganizationInApi } from "@/lib/onboarding";

function sanitizeReturnTo(raw: string | null): string {
  if (!raw) {
    return "/dashboard";
  }

  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return "/dashboard";
  }

  return raw;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = sanitizeReturnTo(url.searchParams.get("returnTo"));

  try {
    await linkOrganizationInApi();
    return NextResponse.redirect(new URL(returnTo, url));
  } catch {
    const fallback = new URL("/dashboard", url);
    fallback.searchParams.set("link", "failed");
    return NextResponse.redirect(fallback);
  }
}
