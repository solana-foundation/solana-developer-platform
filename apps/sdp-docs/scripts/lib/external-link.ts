import { setTimeout } from "node:timers/promises";

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

type ProbeResult = { ok: boolean; status?: number; error?: string };

export async function probeExternalUrl(url: string): Promise<ProbeResult> {
  let result: ProbeResult = { ok: false };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: attempt === 0 ? "HEAD" : "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "sdp-docs-link-checker/1.0" },
      });
      // Only the status matters; do not keep downloading a GET response.
      await response.body?.cancel();
      const status = response.status;
      if ([401, 403, 429].includes(status) || (status >= 200 && status < 400)) {
        return { ok: true, status };
      }
      result = { ok: false, status };
      // Some hosts refuse HEAD. A GET fallback is still subject to the limit.
      if (status === 405 && attempt === 0) continue;
      if (status < 500) return result;
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // GitHub and other hosts can briefly return 5xx or drop a connection. Retry
    // those failures with GET, but still fail the check if they persist.
    if (attempt + 1 < MAX_ATTEMPTS) await setTimeout(500 * (attempt + 1));
  }
  return result;
}
