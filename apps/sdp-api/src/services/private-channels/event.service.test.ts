import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  PRIVATE_CHANNEL_EVENT_TYPES,
} from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import { rootLogger } from "@/runtime/logger";
import type { PrivateChannelEventRecord, PrivateChannelEventSink } from "./event.service";
import { PrivateChannelEventService } from "./event.service";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "org_1",
    projectId: "prj_1",
    instanceId: "pci_1",
    family: PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
    type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
    status: PRIVATE_CHANNEL_EVENT_STATUSES.INFO,
    payload: { name: "Treasury" },
    ...overrides,
  };
}

describe("PrivateChannelEventService", () => {
  it("builds a full record and fans out to all sinks", async () => {
    const seen: string[] = [];
    const sinkA: PrivateChannelEventSink = {
      name: "a",
      handle(event) {
        seen.push(`a:${event.id}:${event.type}`);
        expect(event.id).toMatch(/^pce_/);
        expect(event.channelId).toBeNull();
        expect(event.payload).toEqual({ name: "Treasury" });
        expect(event.occurredAt).toBeTruthy();
        expect(event.createdAt).toBeTruthy();
      },
    };
    const sinkB: PrivateChannelEventSink = {
      name: "b",
      handle(event) {
        seen.push(`b:${event.id}`);
      },
    };

    const service = new PrivateChannelEventService([sinkA, sinkB]);
    await service.emit(baseInput());
    expect(seen).toHaveLength(2);
    expect(seen[0]?.startsWith("a:pce_")).toBe(true);
    expect(seen[1]?.startsWith("b:pce_")).toBe(true);
  });

  it("isolates a throwing sink so emit still resolves and peers run", async () => {
    const ran: string[] = [];
    const throwing: PrivateChannelEventSink = {
      name: "boom",
      handle() {
        ran.push("boom");
        throw new Error("sink failed");
      },
    };
    const ok: PrivateChannelEventSink = {
      name: "ok",
      handle() {
        ran.push("ok");
      },
    };
    const errorSpy = vi.spyOn(rootLogger, "error").mockImplementation(() => undefined);

    const service = new PrivateChannelEventService([throwing, ok]);
    await expect(service.emit(baseInput())).resolves.toBeUndefined();
    expect(ran).toEqual(["boom", "ok"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("recordError forces family=error status=failed and folds error into payload", async () => {
    const captured: { event: PrivateChannelEventRecord | null } = { event: null };
    const sink: PrivateChannelEventSink = {
      name: "cap",
      handle(event) {
        captured.event = event;
      },
    };
    const service = new PrivateChannelEventService([sink]);
    await service.recordError({
      organizationId: "org_1",
      projectId: "prj_1",
      instanceId: "pci_1",
      type: PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE,
      error: new Error("gateway timeout"),
      payload: { attempt: 1 },
    });

    expect(captured.event).not.toBeNull();
    expect(captured.event?.family).toBe(PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR);
    expect(captured.event?.status).toBe(PRIVATE_CHANNEL_EVENT_STATUSES.FAILED);
    expect(captured.event?.type).toBe(PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE);
    expect(captured.event?.payload).toMatchObject({
      attempt: 1,
      message: "gateway timeout",
      name: "Error",
    });
  });
});
