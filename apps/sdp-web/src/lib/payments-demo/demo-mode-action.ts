"use server";

import { cookies } from "next/headers";
import { paymentsDemoMode } from "@/flags";
import { getSdpAuth } from "../sdp-api";
import { isDemoSessionCookie, PAYMENTS_DEMO_COOKIE_NAME } from "./demo-cookie";

const DEMO_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
// Project ids are URL-safe; anything else is not written into a cookie.
const COOKIE_SAFE_VALUE = /^[\w-]{1,80}$/;

/**
 * The demo mode switch. On, it names the project whose Payments screens run the demo: the one
 * in the tab's URL. Off, it clears that. Either way it forgets what was done in the demo so far. Returns whether the
 * switch took; the caller then redraws the page, dropping what it had cached.
 *
 * A server action can be called directly, so it does nothing for a caller who isn't signed in
 * to an organization, and turns the demo on only while its flag is on.
 */
export async function setPaymentsDemoAction(
  enabled: boolean,
  projectId: string | null
): Promise<boolean> {
  const { userId, orgId } = await getSdpAuth();
  if (!userId || !orgId) {
    return false;
  }
  if (enabled && !(await paymentsDemoMode())) {
    return false;
  }
  const store = await cookies();
  for (const { name } of store.getAll()) {
    if (isDemoSessionCookie(name)) store.delete(name);
  }
  if (!enabled) {
    store.delete(PAYMENTS_DEMO_COOKIE_NAME);
    return true;
  }
  if (!projectId || !COOKIE_SAFE_VALUE.test(projectId)) {
    return false;
  }
  store.set(PAYMENTS_DEMO_COOKIE_NAME, projectId, {
    path: "/",
    maxAge: DEMO_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
  });
  return true;
}
