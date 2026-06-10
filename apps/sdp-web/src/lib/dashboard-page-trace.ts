import { createTimedTrace } from "./request-tracing";
import { createSdpApiClient, type SdpApiClient } from "./sdp-api";

export type DashboardPageTraceContext = {
  trace: ReturnType<typeof createTimedTrace>;
  apiClient: SdpApiClient;
};

export async function withDashboardPageTrace<T>(
  source: string,
  fn: (ctx: DashboardPageTraceContext) => Promise<T>
): Promise<T> {
  const trace = createTimedTrace(source);
  try {
    const apiClient = await trace.step("create_sdp_api_client", () =>
      createSdpApiClient(trace.childContext(`${source}.api`))
    );
    return await fn({ trace, apiClient });
  } catch (error) {
    trace.log({ ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    throw error;
  }
}
