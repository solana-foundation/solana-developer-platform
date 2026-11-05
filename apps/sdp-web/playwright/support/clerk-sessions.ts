import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

/**
 * Where a run records the Clerk sessions it signs in, one empty file per
 * session id, so `auth.global.teardown.ts` can revoke exactly those: a shared
 * test user (the stage smoke's, the canary's) may have other runs' sessions
 * live at the same time, and those must survive.
 */
const SESSIONS_DIR = path.join(__dirname, "../.clerk/sessions");
const SESSION_ID = /^sess_[A-Za-z0-9]+$/;

/**
 * Records the page's current Clerk session for revocation at the end of the run.
 *
 * @param page - A page signed in through Clerk.
 */
export async function recordClerkSession(page: Page): Promise<void> {
  const sessionId = await page.evaluate(
    () => (window as unknown as { Clerk?: { session?: { id?: string } } }).Clerk?.session?.id
  );
  if (!sessionId || !SESSION_ID.test(sessionId)) {
    return;
  }
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, sessionId), "");
}

/**
 * Revokes every session this run recorded through the Clerk Backend API, then
 * forgets it. Never throws: a revoke that fails is reported, and the session
 * still expires on Clerk's own schedule.
 *
 * @param secretKey - The Clerk instance's secret key.
 * @returns How many sessions were revoked and which failed.
 */
export async function revokeRecordedClerkSessions(
  secretKey: string
): Promise<{ revoked: number; failed: string[] }> {
  const sessionIds = fs.existsSync(SESSIONS_DIR)
    ? fs.readdirSync(SESSIONS_DIR).filter((name) => SESSION_ID.test(name))
    : [];
  let revoked = 0;
  const failed: string[] = [];
  for (const sessionId of sessionIds) {
    try {
      const response = await fetch(`https://api.clerk.com/v1/sessions/${sessionId}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      // A session already revoked or ended answers 4xx; it is gone either way.
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        revoked += 1;
        fs.rmSync(path.join(SESSIONS_DIR, sessionId), { force: true });
      } else {
        failed.push(`${sessionId}: ${response.status}`);
      }
    } catch (error) {
      failed.push(`${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { revoked, failed };
}
