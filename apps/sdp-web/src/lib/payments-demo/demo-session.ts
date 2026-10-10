import { deflateRawSync, inflateRawSync } from "node:zlib";
import { cookies } from "next/headers";
import { DEMO_SESSION_COOKIE_PREFIX, isDemoSessionCookie } from "./demo-cookie";
import { type DemoOp, parseDemoOps } from "./demo-ops";

/*
 * The demo session: the log of what the visitor did in demo mode since the page loaded, kept in
 * the browser as a few short cookies and replayed over the fixtures on every demo read. The
 * server stores nothing, so any instance answers the same, and nothing survives a full page
 * load (the proxy drops the cookies then).
 */

/** Cookie values stay well under the 4KB a browser keeps per cookie. */
const CHUNK_LENGTH = 3600;
/** At most this many chunks, so the request headers stay small next to the session's own. */
const MAX_CHUNKS = 3;
const MAX_ENCODED_LENGTH = CHUNK_LENGTH * MAX_CHUNKS;
/**
 * The log's JSON is never longer than this, written or read. A cookie is the browser's to send,
 * so a small, highly compressible one must not inflate into megabytes on every demo read.
 */
export const MAX_DECODED_LENGTH = 64 * 1024;

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/** The log as this request has it, writes included, since a cookie set is not read back. */
const requestLogs = new WeakMap<CookieStore, DemoOp[]>();

function chunkName(index: number): string {
  return `${DEMO_SESSION_COOKIE_PREFIX}.${index}`;
}

/** The log as the cookies carry it: deflated JSON, base64url, split into chunks. */
export function encodeDemoOps(ops: readonly DemoOp[]): string[] {
  // Past either budget the oldest actions go first; the replay tolerates what they referred to.
  let kept = [...ops];
  let json = JSON.stringify(kept);
  // The budget is in bytes, as the read counts them: names and memos can be multi-byte text.
  let jsonBytes = Buffer.byteLength(json, "utf8");
  // The JSON budget is cut in proportion, so a long log isn't deflated once per action dropped.
  while (jsonBytes > MAX_DECODED_LENGTH && kept.length > 0) {
    const keep = Math.floor((kept.length * MAX_DECODED_LENGTH) / jsonBytes);
    kept = kept.slice(kept.length - Math.min(keep, kept.length - 1));
    json = JSON.stringify(kept);
    jsonBytes = Buffer.byteLength(json, "utf8");
  }
  let encoded = deflateRawSync(json).toString("base64url");
  while (encoded.length > MAX_ENCODED_LENGTH && kept.length > 0) {
    kept = kept.slice(1);
    encoded = deflateRawSync(JSON.stringify(kept)).toString("base64url");
  }
  if (kept.length === 0) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += CHUNK_LENGTH) {
    chunks.push(encoded.slice(offset, offset + CHUNK_LENGTH));
  }
  return chunks;
}

/**
 * The log back from its chunks; anything unreadable, or more than the budgets allow, reads as
 * an empty session.
 */
export function decodeDemoOps(chunks: readonly string[]): DemoOp[] {
  if (chunks.length === 0) return [];
  const encoded = chunks.join("");
  if (encoded.length > MAX_ENCODED_LENGTH) return [];
  try {
    // Inflating stops at the budget (it throws past it), so the work is bounded by it too.
    const json = inflateRawSync(Buffer.from(encoded, "base64url"), {
      maxOutputLength: MAX_DECODED_LENGTH,
    }).toString("utf8");
    return parseDemoOps(JSON.parse(json));
  } catch {
    return [];
  }
}

function readChunks(store: CookieStore): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < MAX_CHUNKS; index += 1) {
    const value = store.get(chunkName(index))?.value;
    if (!value) break;
    chunks.push(value);
  }
  return chunks;
}

/** What the visitor has done in demo mode on this page load, oldest first. */
export async function readDemoOps(): Promise<DemoOp[]> {
  let store: CookieStore;
  try {
    store = await cookies();
  } catch {
    return [];
  }
  const known = requestLogs.get(store);
  if (known) return known;
  const ops = decodeDemoOps(readChunks(store));
  requestLogs.set(store, ops);
  return ops;
}

/**
 * Adds actions to the session and writes it back to the browser. Only a route handler or a
 * server action can set cookies; anywhere else the actions hold for this request alone.
 */
export async function appendDemoOps(...added: DemoOp[]): Promise<DemoOp[]> {
  const store = await cookies();
  const ops = [...(await readDemoOps()), ...added];
  requestLogs.set(store, ops);
  const chunks = encodeDemoOps(ops);
  try {
    chunks.forEach((chunk, index) => {
      store.set(chunkName(index), chunk, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    });
    for (const cookie of store.getAll()) {
      const index = Number(cookie.name.slice(DEMO_SESSION_COOKIE_PREFIX.length + 1));
      if (isDemoSessionCookie(cookie.name) && !(index < chunks.length)) {
        store.delete(cookie.name);
      }
    }
  } catch {
    // A server component render cannot set cookies; the change lives for this request only.
  }
  return ops;
}
