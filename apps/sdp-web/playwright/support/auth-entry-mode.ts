export function isClosedAuthEntryMode(): boolean {
  return process.env.PLAYWRIGHT_SDP_AUTH_ENTRY_ENABLED === "false";
}
