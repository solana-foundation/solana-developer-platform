import { vi } from "vitest";
import { parseDashboardPathname } from "@/lib/dashboard-project-path";
import { PROJECT_COOKIE_NAME, PROJECT_HEADER_NAME } from "@/lib/project-cookie";

let requestHeaders = new Headers();
const requestCookieValues = new Map<string, string>();

/** Cookie store returned by the mocked `cookies()`; `set` and `delete` are spies that also update it. */
export const requestCookies = {
  get: (name: string): { name: string; value: string } | undefined => {
    const value = requestCookieValues.get(name);
    return value === undefined ? undefined : { name, value };
  },
  set: vi.fn((name: string, value: string): void => {
    requestCookieValues.set(name, value);
  }),
  delete: vi.fn((name: string): void => {
    requestCookieValues.delete(name);
  }),
};

/** Request headers as proxy.ts builds them for a page render or server action at `pathname`. */
export function setPageRequest(pathname: string): void {
  requestHeaders = new Headers({ "x-sdp-pathname": pathname });
  const { projectId } = parseDashboardPathname(pathname);
  if (projectId !== null) {
    requestHeaders.set(PROJECT_HEADER_NAME, projectId);
  }
}

/** Request headers of a browser `/api/*` call, with the Project `dashboardRequest` sent or none. */
export function setApiRequest(projectId: string | null): void {
  requestHeaders = new Headers();
  if (projectId !== null) {
    requestHeaders.set(PROJECT_HEADER_NAME, projectId);
  }
}

/** Sets or clears the last-used Project cookie the bare landing reads. */
export function setLastUsedProjectCookie(projectId: string | null): void {
  if (projectId === null) {
    requestCookieValues.delete(PROJECT_COOKIE_NAME);
  } else {
    requestCookieValues.set(PROJECT_COOKIE_NAME, projectId);
  }
}

/** Empties headers and cookies and clears the spies; call from `beforeEach`. */
export function resetRequestProject(): void {
  requestHeaders = new Headers();
  requestCookieValues.clear();
  requestCookies.set.mockClear();
  requestCookies.delete.mockClear();
}

/**
 * Stand-in for `next/headers`, serving the request from the setters above.
 * Tests mock with `vi.mock("next/headers", () => import("@/test/next-headers"));`
 */
export const nextHeadersMock = {
  headers: async (): Promise<Headers> => requestHeaders,
  cookies: async () => requestCookies,
};
