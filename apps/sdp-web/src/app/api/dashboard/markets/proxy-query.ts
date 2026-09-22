import { NextResponse } from "next/server";

export type ProxyQueryValidation = { ok: true; query: string } | { ok: false; message: string };

/**
 * The 400 every rejected proxy query renders, so the error envelope's shape is
 * spelled once, beside the verdict type that names the rejection. Lives at the
 * `markets/` root because both the earn and the DvP proxy trees validate their
 * queries against it.
 */
export function proxyQueryErrorResponse(
  validated: Extract<ProxyQueryValidation, { ok: false }>
): NextResponse {
  return NextResponse.json({ error: { message: validated.message } }, { status: 400 });
}
