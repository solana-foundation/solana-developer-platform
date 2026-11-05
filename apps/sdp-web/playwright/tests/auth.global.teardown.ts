import { test as teardown } from "@playwright/test";
import { getE2EEnv } from "../env";
import { revokeRecordedClerkSessions } from "../support/clerk-sessions";

// Runs after every project that depends on `auth-setup`. Each run used to leave
// its Clerk sessions active until they expired, so the shared test users piled
// up sessions; this revokes the ones the run signed in. It never fails the run:
// a release gate must not go red over a cleanup step.
teardown("revoke the Clerk sessions this run signed in", async () => {
  const { revoked, failed } = await revokeRecordedClerkSessions(getE2EEnv().clerkSecretKey);
  console.log(`Clerk session teardown: revoked ${revoked}`);
  for (const failure of failed) {
    console.warn(`Clerk session teardown: could not revoke ${failure}`);
  }
});
