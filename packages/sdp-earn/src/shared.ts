export function bearerAuthHeader(token: string): string {
  return `Bearer ${token}`;
}
