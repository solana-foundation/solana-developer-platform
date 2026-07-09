export function parseErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed?.error?.message ?? parsed?.message ?? body ?? "Unknown error";
  } catch {
    return body || "Unknown error";
  }
}
