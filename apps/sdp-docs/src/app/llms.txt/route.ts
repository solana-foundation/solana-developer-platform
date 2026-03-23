import { NextResponse } from "next/server";

export function GET(request: Request) {
  return NextResponse.redirect(new URL("/docs/ai/llms.txt", request.url), { status: 308 });
}
