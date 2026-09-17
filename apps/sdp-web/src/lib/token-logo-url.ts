/**
 * Issuer-supplied logo URLs render as a raw `<img src>`, so the string alone
 * picks the one network request the token mark may issue. Upstream issuance
 * validates the scheme at write time, but this render boundary is shared by
 * every surface: anything that is not a credential-free https URL is rejected
 * rather than letting token metadata point the dashboard's network at an
 * arbitrary origin.
 */
export function isRenderableLogoUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}
