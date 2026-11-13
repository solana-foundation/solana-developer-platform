import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { getE2EEnv } from "@/playwright/env";

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
const SMALLEST_LIMIT = Math.min(...COUNTERS.map((counter) => counter.limit));

/**
 * Requests left free before a test may start. The heaviest dashboard test makes about
 * 110 Clerk-authenticated requests, so the default of 150 lets any one of them finish
 * under the limit. It must leave room under the smallest limit, or every test waits.
 */
const HEADROOM = z.coerce
  .number()
  .int()
  .min(0)
  .max(SMALLEST_LIMIT - 1)
  .default(150)
  .parse(process.env.PLAYWRIGHT_RATE_LIMIT_HEADROOM);
/** Longest a pause may last: a full window always drains the previous one. */
const MAX_WAIT_MS = 2 * WINDOW_MS;
const POLL_MS = 1_000;

const LOG_PATH = path.join(__dirname, "../../test-results/rate-budget.jsonl");

const scanReplySchema = z.tuple([z.string(), z.array(z.string())]);
// MGET answers null for a key that expired between SCAN and MGET: no requests left in it.
const mgetReplySchema = z.array(z.string().nullable());

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
 * Sends one command over a short-lived connection and returns its reply. This reads a
 * few commands a second at most, so it needs no client library (and no dependency):
 * only SCAN and MGET, after AUTH and SELECT when the URL names them.
 *
 * @throws When Redis refuses a command, the connection fails or closes before every
 *   reply arrives, or nothing arrives within five seconds.
 */
function redisCommand(url: URL, command: readonly (string | number)[]): Promise<RespValue> {
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
  const all = [...setup, command];

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      outcome();
    };
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
        settle(() => reject(error));
        return;
      }
      socket.end();
      settle(() => resolve(replies[replies.length - 1]));
    });
    socket.on("error", (error) => settle(() => reject(error)));
    // A connection that closes before every reply arrived must not leave the test waiting.
    socket.on("close", () =>
      settle(() => reject(new Error("Redis: connection closed before the reply")))
    );
  });
}

/**
 * The run's own Redis, or null when the run talks to a deployed API whose Redis it
 * cannot read (the external smoke).
 *
 * @throws When a run against the local API has no REDIS_URL: the local API cannot
 *   start without one, so its absence here means the run is misconfigured.
 */
function redisUrl(): URL | null {
  if (getE2EEnv().useExternalApi) return null;
  return new URL(z.string().trim().min(1).parse(process.env.REDIS_URL));
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
    const [next, batch] = scanReplySchema.parse(
      await redisCommand(url, ["SCAN", cursor, "MATCH", "*ratelimit:*", "COUNT", 500])
    );
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  const values =
    keys.length > 0 ? mgetReplySchema.parse(await redisCommand(url, ["MGET", ...keys])) : [];

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
      const value = values[index];
      const count = value === null ? 0 : Number(value);
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

/** A reading without its Clerk user and org ids: CI uploads the log as an artifact. */
function loggable(reading: RateLimitReading | undefined) {
  return reading
    ? { counter: reading.counter, estimate: reading.estimate, limit: reading.limit }
    : null;
}

function record(entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/**
 * Waits until every per-user counter has HEADROOM requests free, then records what it saw.
 *
 * @param label - What is about to run, for the log.
 * @returns How long it waited, in milliseconds.
 * @throws When the counters cannot be read, or stay over budget for MAX_WAIT_MS: a test
 *   started then would run into the API's 429 and fail somewhere less obvious.
 */
export async function waitForRateLimitBudget(label: string): Promise<number> {
  const started = Date.now();
  let readings = await readRateLimits();
  const before = readings[0];
  let stuck = overBudget(readings);
  while (stuck) {
    if (Date.now() - started >= MAX_WAIT_MS) {
      throw new Error(
        `Rate-limit budget never freed up before "${label}": ${stuck.counter} stayed at ${stuck.estimate}/${stuck.limit} for ${MAX_WAIT_MS}ms`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    readings = await readRateLimits();
    stuck = overBudget(readings);
  }
  const waitedMs = Date.now() - started;
  record({
    event: "budget",
    label,
    waitedMs,
    before: loggable(before),
    after: loggable(readings[0]),
  });
  if (before && overBudget([before])) {
    console.log(
      `[rate-budget] waited ${waitedMs}ms before "${label}" (${before.counter} at ${before.estimate}/${before.limit})`
    );
  }
  return waitedMs;
}

/** Records the counters after a test, so the log shows what each test used. */
export async function recordRateLimitUsage(
  label: string,
  status: string | undefined
): Promise<void> {
  const readings = await readRateLimits();
  record({ event: "after", label, status: status ?? null, top: loggable(readings[0]) });
}
