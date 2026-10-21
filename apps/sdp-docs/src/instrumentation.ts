export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@sdp/env-config/tls-trust");
  }
}
