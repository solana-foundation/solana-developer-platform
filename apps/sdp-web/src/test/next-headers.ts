import { nextHeadersMock } from "./request-project";

/** `next/headers` stand-in: `vi.mock("next/headers", () => import("@/test/next-headers"));` */
export const { headers, cookies } = nextHeadersMock;
