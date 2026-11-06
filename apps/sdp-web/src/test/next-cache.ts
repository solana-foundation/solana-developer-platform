import type { revalidatePath as nextRevalidatePath } from "next/cache";
import { vi } from "vitest";

/** `next/cache` stand-in: `vi.mock("next/cache", () => import("@/test/next-cache"));` */
export const revalidatePath = vi.fn<typeof nextRevalidatePath>();
