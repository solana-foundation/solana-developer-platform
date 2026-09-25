import { cookies, headers } from "next/headers";
import { cache } from "react";
import { isPaymentsPath, PAYMENTS_DEMO_COOKIE_NAME } from "./demo-cookie";
import { paymentsDemoBody } from "./demo-fixtures";

/**
 * Whether this request renders, or is fetched by, a Payments screen of the project the demo
 * cookie names. A page carries its own path (the proxy stamps `x-sdp-pathname`); a dashboard
 * API route counts only when a Payments page called it (its Referer). Everything else, the API
 * playground included, keeps real data.
 */
const demoRequested = cache(async (projectId: string | null): Promise<boolean> => {
  if (!projectId) {
    return false;
  }
  try {
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    if (cookieStore.get(PAYMENTS_DEMO_COOKIE_NAME)?.value !== projectId) {
      return false;
    }
    const pathname = headerStore.get("x-sdp-pathname");
    if (isPaymentsPath(pathname)) {
      return true;
    }
    if (!pathname?.startsWith("/api/dashboard/")) {
      return false;
    }
    const referer = headerStore.get("referer");
    return referer ? isPaymentsPath(new URL(referer).pathname) : false;
  } catch {
    // Outside a request there are no cookies or headers to read, so no demo.
    return false;
  }
});

/**
 * The demo's answer to an SDP API request, or null to send it upstream. Reads the demo covers
 * come from the fixtures; every write is refused, so nothing real happens against demo ids.
 */
export async function paymentsDemoResponse(
  method: string,
  path: string,
  projectId: string | null
): Promise<Response | null> {
  if (!(await demoRequested(projectId))) {
    return null;
  }
  if (method.toUpperCase() !== "GET") {
    return Response.json(
      {
        error: {
          code: "payments_demo",
          message: "Demo data is on, so changes are off. Turn off the demo to make changes.",
        },
      },
      { status: 409 }
    );
  }
  const body = paymentsDemoBody(path);
  return body === undefined ? null : Response.json(body);
}
