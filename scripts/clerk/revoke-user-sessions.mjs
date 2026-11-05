#!/usr/bin/env node
// Revokes a Clerk user's active sessions through the Backend API, for clearing
// the sessions automated sign-ins (smoke, canary, traffic) leave behind.
//
// Usage (dry run first; it only lists what it would revoke):
//   doppler run --project solana-developer-platform --config <config> -- \
//     node scripts/clerk/revoke-user-sessions.mjs --email <user email>
// Then add --apply to revoke. Options:
//   --user-id <id>          instead of --email
//   --older-than-minutes N  keep sessions younger than N minutes (default 10),
//                           so a run in flight keeps its session
//
// Reads CLERK_SECRET_KEY from the environment; the key's instance decides which
// Clerk users and sessions it can see. Never prints a token.

const API = "https://api.clerk.com/v1";
const PAGE_SIZE = 100;
const CONCURRENCY = 4;

function parseArgs(argv) {
  const args = { apply: false, olderThanMinutes: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--apply") args.apply = true;
    else if (flag === "--email") args.email = argv[++i];
    else if (flag === "--user-id") args.userId = argv[++i];
    else if (flag === "--older-than-minutes") args.olderThanMinutes = Number(argv[++i]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.email === !args.userId) throw new Error("pass exactly one of --email or --user-id");
  if (!Number.isFinite(args.olderThanMinutes) || args.olderThanMinutes < 0) {
    throw new Error("--older-than-minutes must be a non-negative number");
  }
  return args;
}

const secretKey = process.env.CLERK_SECRET_KEY?.trim();

async function clerk(path, init = {}, attempt = 1) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
  });
  if (response.status === 429 && attempt <= 5) {
    const waitSeconds = Number(response.headers.get("retry-after")) || 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    return clerk(path, init, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path.split("?")[0]} -> ${response.status}: ${await response.text()}`
    );
  }
  return response.json();
}

async function resolveUserId({ email, userId }) {
  if (userId) return userId;
  const users = await clerk(`/users?email_address=${encodeURIComponent(email)}&limit=2`);
  const list = Array.isArray(users) ? users : users.data;
  if (list.length !== 1)
    throw new Error(`expected one Clerk user for ${email}, found ${list.length}`);
  return list[0].id;
}

async function activeSessions(userId) {
  const sessions = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await clerk(
      `/sessions?user_id=${encodeURIComponent(userId)}&status=active&limit=${PAGE_SIZE}&offset=${offset}`
    );
    const rows = Array.isArray(page) ? page : page.data;
    sessions.push(...rows);
    if (rows.length < PAGE_SIZE) return sessions;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!secretKey) throw new Error("CLERK_SECRET_KEY is not set (run under doppler run)");

  const userId = await resolveUserId(args);
  const cutoff = Date.now() - args.olderThanMinutes * 60_000;
  const sessions = await activeSessions(userId);
  const targets = sessions.filter((session) => session.created_at < cutoff);
  console.log(
    `${userId}: ${sessions.length} active sessions, ${targets.length} older than ${args.olderThanMinutes} min`
  );
  if (!args.apply) {
    for (const session of targets.slice(0, 10)) {
      console.log(
        `  would revoke ${session.id} (created ${new Date(session.created_at).toISOString()})`
      );
    }
    if (targets.length > 10) console.log(`  ...and ${targets.length - 10} more`);
    console.log("Dry run. Re-run with --apply to revoke.");
    return;
  }

  let revoked = 0;
  let failed = 0;
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let session = queue.shift(); session; session = queue.shift()) {
        try {
          await clerk(`/sessions/${session.id}/revoke`, { method: "POST" });
          revoked += 1;
        } catch (error) {
          failed += 1;
          console.error(`  failed ${session.id}: ${error.message}`);
        }
      }
    })
  );
  console.log(`Revoked ${revoked}, failed ${failed}.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
