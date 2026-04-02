export function isClosedAuthEntryMode(): boolean {
  const signInEnabled = process.env.PLAYWRIGHT_SDP_SIGN_IN_ENTRY_ENABLED;
  const signUpEnabled = process.env.PLAYWRIGHT_SDP_SIGN_UP_ENTRY_ENABLED;

  return signInEnabled === "false" && signUpEnabled === "false";
}
