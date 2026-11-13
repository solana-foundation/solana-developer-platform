import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { getE2EEnv } from "../env";

/**
 * Keeps the suite under sdp-api's per-user rate limits by pausing before a test or a
 * fixture bootstrap until the limits have room for it.
 *
 * Every dashboard spec signs in as one Clerk user, and each dashboard page load makes
 * about nine sdp-api requests, so a single worker driving pages back to back runs at
 * the per-user limit. The API refuses whatever crosses it (429) for up to a minute,
 * and whichever test is running then fails on an error page. Instead of guessing a
 * fixed delay, this reads the counters the API itself enforces, in the run's own
 * Redis, with the API's sliding-window estimate, so it waits only when the next test
 * could run out of room, and only as long as that takes.
 *
 * The limits mirror apps/sdp-api/src/middleware/rate-limit.ts: CLERK_USER_MAX_REQUESTS
 * (`clerk:<userId>`) and DASHBOARD_ACTOR_MAX_REQUESTS (`user:<userId>:org:<orgId>`).
 */
const WINDOW_MS = 60_000;
const COUNTERS = [
  { name: "clerk-user", match: /^(?:.*:)?ratelimit:(clerk:[^:]+):(\d+)$/, limit: 600 },
  { name: "user-org", match: /^(?:.*:)?ratelimit:(user:[^:]+:org:[^:]+):(\d+)$/, limit: 300 },
] as const;

/**
 * Requests left free before a test may start. The heaviest dashboard test makes about
 * 110 Clerk-authenticated requests, so 150 lets any one of them finish under the limit.
 */
const HEADROOM = Number(process.env.PLAYWRIGHT_RATE_LIMIT_HEADROOM ?? 150);
/** Longest a pause may last: a full window always drains the previous one. */
const MAX_WAIT_MS = 2 * WINDOW_MS;
const POLL_MS = 1_000;

const LOG_PATH = path.join(__dirname, "../../test-results/rate-budget.jsonl");

type RespValue = string | number | null | RespValue[];

/** Parses one RESP reply from `buffer` at `offset`, or returns null until it is complete. */
function parseReply(buffer: Buffer, offset: number): [RespValue, number] | null {
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const type = String.fromCharCode(buffer[offset]);
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;
  if (type === "+") return [line, next];
  if (type === "-") throw new Error(`Redis: ${line}`);
  if (type === ":") return [Number(line), next];
  if (type === "$") {
    const length = Number(line);
    if (length < 0) return [null, next];
    if (buffer.length < next + length + 2) return null;
    return [buffer.toString("utf8", next, next + length), next + length + 2];
  }
  if (type === "*") {
    const count = Number(line);
    if (count < 0) return [null, next];
    const items: RespValue[] = [];
    let cursor = next;
    for (let index = 0; index < count; index++) {
      const item = parseReply(buffer, cursor);
      if (!item) return null;
      items.push(item[0]);
      cursor = item[1];
    }
    return [items, cursor];
  }
  throw new Error(`Redis: unexpected reply type ${type}`);
}

function encode(args: readonly (string | number)[]): string {
  const parts = args.map((arg) => `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`);
  return `*${args.length}\r\n${parts.join("")}`;
}

/**
 * Sends commands over one short-lived connection and returns their replies. This reads
 * a few commands a second at most, so it needs no client library (and no dependency):
 * only SCAN and MGET, after AUTH and SELECT when the URL names them.
 */
function redisCommands(
  url: URL,
  commands: readonly (readonly (string | number)[])[]
): Promise<RespValue[]> {
  const setup: (string | number)[][] = [];
  if (url.password) {
    setup.push(
      url.username
        ? ["AUTH", decodeURIComponent(url.username), decodeURIComponent(url.password)]
        : ["AUTH", decodeURIComponent(url.password)]
    );
  }
  const db = url.pathname.replace(/^\//, "");
  if (db) setup.push(["SELECT", db]);
  const all = [...setup, ...commands];

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 6379) });
    socket.setTimeout(5_000, () => socket.destroy(new Error("Redis: timed out")));
    let buffer = Buffer.alloc(0);
    socket.on("connect", () => socket.write(all.map(encode).join("")));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const replies: RespValue[] = [];
      let offset = 0;
      try {
        while (replies.length < all.length) {
          const reply = parseReply(buffer, offset);
          if (!reply) return;
          replies.push(reply[0]);
          offset = reply[1];
        }
      } catch (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.end();
      resolve(replies.slice(setup.length));
    });
    socket.on("error", reject);
  });
}

/** The run's own Redis, or null when the run cannot read the API's counters. */
function redisUrl(): URL | null {
  const raw = process.env.REDIS_URL?.trim();
  // The external smoke runs against a deployed API whose Redis the run cannot read.
  if (getE2EEnv().useExternalApi || !raw) return null;
  return new URL(raw);
}

export interface RateLimitReading {
  counter: string;
  identifier: string;
  estimate: number;
  limit: number;
}

/** The API's sliding-window estimate for every live counter, highest share of its limit first. */
export async function readRateLimits(): Promise<RateLimitReading[]> {
  const url = redisUrl();
  if (!url) return [];
  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const previousWeight = Math.max(0, 1 - (now - windowStart) / WINDOW_MS);

  const keys: string[] = [];
  let cursor = "0";
  do {
    const [reply] = await redisCommands(url, [
      ["SCAN", cursor, "MATCH", "*ratelimit:*", "COUNT", 500],
    ]);
    const [next, batch] = reply as [string, string[]];
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  const values =
    keys.length > 0
      ? ((await redisCommands(url, [["MGET", ...keys]]))[0] as (string | null)[])
      : [];

  const windows = new Map<
    string,
    { counter: string; limit: number; current: number; previous: number }
  >();
  keys.forEach((key, index) => {
    for (const counter of COUNTERS) {
      const match = counter.match.exec(key);
      if (!match) continue;
      const [, identifier, start] = match;
      const entry = windows.get(identifier) ?? {
        counter: counter.name,
        limit: counter.limit,
        current: 0,
        previous: 0,
      };
      const count = Number(values[index] ?? 0);
      if (Number(start) === windowStart) entry.current = count;
      if (Number(start) === windowStart - WINDOW_MS) entry.previous = count;
      windows.set(identifier, entry);
      return;
    }
  });

  return [...windows.entries()]
    .map(([identifier, entry]) => ({
      counter: entry.counter,
      identifier,
      estimate: Math.round(entry.current + entry.previous * previousWeight),
      limit: entry.limit,
    }))
    .sort((a, b) => b.estimate / b.limit - a.estimate / a.limit);
}

function overBudget(readings: RateLimitReading[]): RateLimitReading | undefined {
  return readings.find((reading) => reading.estimate > reading.limit - HEADROOM);
}

function record(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Instrumentation only: a run never fails on its log.
  }
}

/**
 * Waits until every per-user counter has HEADROOM requests free, then records what it
 * saw. Never throws: a Redis it cannot read, or a wait that runs out, lets the test run.
 *
 * @param label - What is about to run, for the log.
 * @returns How long it waited, in milliseconds.
 */
export async function waitForRateLimitBudget(label: string): Promise<number> {
  const started = Date.now();
  try {
    let readings = await readRateLimits();
    const before = readings[0] ?? null;
    while (overBudget(readings) && Date.now() - started < MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      readings = await readRateLimits();
    }
    const waitedMs = Date.now() - started;
    record({ event: "budget", label, waitedMs, before, after: readings[0] ?? null });
    if (before && overBudget([before])) {
      console.log(
        `[rate-budget] waited ${waitedMs}ms before "${label}" (${before.counter} at ${before.estimate}/${before.limit})`
      );
    }
    return waitedMs;
  } catch (error) {
    record({ event: "budget-error", label, error: String(error) });
    return Date.now() - started;
  }
}

/** Records the counters after a test, so the log shows what each test used. */
export async function recordRateLimitUsage(label: string, status: string): Promise<void> {
  try {
    const readings = await readRateLimits();
    record({ event: "after", label, status, top: readings[0] ?? null });
  } catch (error) {
    record({ event: "after-error", label, error: String(error) });
  }
}
