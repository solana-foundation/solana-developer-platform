import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    const { resolveSdpReleaseChannel } = await import("@sdp/types");
    const { checkSdpReleaseChannelAgainstApi } = await import("./flags/release-channel-check");
    // A typo'd release channel fails server start; the API comparison runs in the background.
    resolveSdpReleaseChannel(process.env.SDP_RELEASE_CHANNEL);
    void checkSdpReleaseChannelAgainstApi(
      {
        SDP_RELEASE_CHANNEL: process.env.SDP_RELEASE_CHANNEL,
        SDP_API_BASE_URL: process.env.SDP_API_BASE_URL,
        NEXT_PUBLIC_SDP_API_BASE_URL: process.env.NEXT_PUBLIC_SDP_API_BASE_URL,
        NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
      },
      fetch
    );
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
