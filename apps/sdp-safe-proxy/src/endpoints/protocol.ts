// The local proxy's stand-in for an identity token: the caller names itself.
export const LOCAL_CALLER_HEADER = "x-safe-proxy-local-caller";

// Set only on an answer passed back from a provider. An answer without it did not come from the
// provider.
export const FROM_PROVIDER_HEADER = "sdp-safe-proxy-from-provider";
