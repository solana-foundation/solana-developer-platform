import { timingSafeEqual } from "node:crypto";

export const DEMO_SESSION_HEADER = "X-Northstar-Demo-Session";

export function hasValidDemoSession(
  providedToken: string | undefined,
  expectedToken: string
): boolean {
  if (!providedToken) return false;

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
