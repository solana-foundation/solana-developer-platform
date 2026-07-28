/**
 * SDP API failures surface as `SDP API request failed (400): {"error":{…}}`.
 * Rendering that verbatim puts a JSON blob in front of the user, so pull out
 * the message the API actually wrote and fall back to the raw text.
 *
 * Deliberately not in a "use server" module: those may only export async
 * functions, so a synchronous helper there fails the build.
 */
export function readableApiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) {
    return raw;
  }

  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}
