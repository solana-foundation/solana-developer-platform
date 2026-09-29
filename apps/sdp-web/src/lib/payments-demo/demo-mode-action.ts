"use server";

import { cookies } from "next/headers";
import { PROJECT_COOKIE_NAME } from "../project-cookie";
import { isDemoSessionCookie, PAYMENTS_DEMO_COOKIE_NAME } from "./demo-cookie";

const DEMO_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
// Project ids are URL-safe; anything else is not written into a cookie.
const COOKIE_SAFE_VALUE = /^[\w-]{1,80}$/;

/**
 * The demo mode switch. On, it names the project whose Payments screens run the demo: the one
 * the dashboard has selected, or the project cookie's when the project list didn't load. Off,
 * it clears that. Either way it forgets what was done in the demo so far. Returns whether the
 * switch took; the caller then redraws the page, dropping what it had cached.
 */
export async function setPaymentsDemoAction(
  enabled: boolean,
  projectId: string | null
): Promise<boolean> {
  const store = await cookies();
  for (const { name } of store.getAll()) {
    if (isDemoSessionCookie(name)) store.delete(name);
  }
  if (!enabled) {
    store.delete(PAYMENTS_DEMO_COOKIE_NAME);
    return true;
  }
  const project = projectId ?? store.get(PROJECT_COOKIE_NAME)?.value ?? null;
  if (!project || !COOKIE_SAFE_VALUE.test(project)) {
    return false;
  }
  store.set(PAYMENTS_DEMO_COOKIE_NAME, project, {
    path: "/",
    maxAge: DEMO_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
  });
  return true;
}
