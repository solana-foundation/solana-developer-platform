import { nextNavigationMock } from "./dashboard-navigation";

/** `next/navigation` stand-in: `vi.mock("next/navigation", () => import("@/test/next-navigation"));` */
export const { useParams, usePathname, useSearchParams, useRouter, redirect, notFound } =
  nextNavigationMock;
