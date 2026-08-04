export function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${key}.`);
  }
  return value;
}

export function bearerAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

export function earnId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
