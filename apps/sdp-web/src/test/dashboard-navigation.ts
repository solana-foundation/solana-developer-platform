import { vi } from "vitest";
import { parseDashboardPathname } from "@/lib/dashboard-project-path";

const TEST_ORIGIN = "https://dashboard.test";
const INITIAL_DASHBOARD_URL = "/dashboard/prj_test_sandbox";

let currentUrl = new URL(INITIAL_DASHBOARD_URL, TEST_ORIGIN);
let routeParams: Record<string, string> = {};

/** Router spies returned by the mocked `useRouter()`. */
export const dashboardRouter = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

/**
 * Points the mocked hooks at a dashboard URL, e.g. `/dashboard/prj_test_sandbox/payments?tab=send`.
 *
 * @param pathWithQuery - The URL the component renders under.
 * @param params - Route params below the Project segment, e.g. `{ walletId: "wal_test_1" }`.
 */
export function setDashboardUrl(pathWithQuery: string, params: Record<string, string>): void {
  currentUrl = new URL(pathWithQuery, TEST_ORIGIN);
  routeParams = params;
}

/** Restores the Sandbox home URL and clears every navigation spy; call from `beforeEach`. */
export function resetDashboardNavigation(): void {
  currentUrl = new URL(INITIAL_DASHBOARD_URL, TEST_ORIGIN);
  routeParams = {};
  for (const spy of Object.values(dashboardRouter)) {
    spy.mockClear();
  }
  nextNavigationMock.redirect.mockClear();
  nextNavigationMock.notFound.mockClear();
}

/**
 * Stand-in for `next/navigation`, driven by the URL from {@link setDashboardUrl}.
 * `redirect` and `notFound` throw like Next's do, so a server component stops there.
 * Tests mock with `vi.mock("next/navigation", () => import("@/test/next-navigation"));`
 */
export const nextNavigationMock = {
  useParams: (): Record<string, string> => {
    const { projectId } = parseDashboardPathname(currentUrl.pathname);
    return projectId === null ? routeParams : { ...routeParams, projectId };
  },
  usePathname: (): string => currentUrl.pathname,
  useSearchParams: (): URLSearchParams => new URLSearchParams(currentUrl.search),
  useRouter: () => dashboardRouter,
  redirect: vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
};
