import { afterEach, describe, expect, it, vi } from "vitest";
import * as events from "@/runtime/money-path-events";
import { startEarnWorkerTelemetry } from "./earn-worker-telemetry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Earn worker summaries", () => {
  it("aggregates busy work once per minute, resets intervals and separates environments", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(events, "logEvent").mockImplementation(() => {});
    const telemetry = startEarnWorkerTelemetry("operations", ["sandbox", "production"], () => ({
      active: 4,
      listener_connected: false,
    }));
    for (let index = 0; index < 500; index++) telemetry.completed("sandbox");
    telemetry.pickedUp("sandbox", new Date(Date.now() - 1_500).toISOString());
    telemetry.pickedUp("sandbox", new Date(Date.now() - 8_000).toISOString());
    telemetry.failed("sandbox");
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      worker: "operations",
      environment: "sandbox",
      completed: 500,
      pickups: 2,
      pickup_delay_max_ms: 8_000,
      errors: 1,
      active: 4,
      listener_connected: false,
    });
    expect(log.mock.calls[1]?.[1]).toMatchObject({
      environment: "production",
      completed: 0,
      errors: 0,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.mock.calls[2]?.[1]).toMatchObject({
      completed: 0,
      errors: 0,
      pickups: 0,
      pickup_delay_max_ms: 0,
      last_completed_age_seconds: 120,
    });
    telemetry.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledTimes(4);
  });

  it("keeps reporting a stalled worker and records its later recovery", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(events, "logEvent").mockImplementation(() => {});
    let active = 2;
    const telemetry = startEarnWorkerTelemetry("observer", ["sandbox"], () => ({ active }));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(log.mock.calls[2]?.[1]).toMatchObject({
      completed: 0,
      active: 2,
      last_completed_age_seconds: 180,
    });
    active = 0;
    telemetry.completed("sandbox");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.mock.calls[3]?.[1]).toMatchObject({
      completed: 1,
      active: 0,
      last_completed_age_seconds: 60,
    });
    telemetry.stop();
  });
});
