import { redactCredentialSecrets } from "@sdp/custody";
import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  type PrivateChannelEventFamily,
  type PrivateChannelEventStatus,
  type PrivateChannelEventType,
} from "@sdp/types";
import {
  createPrivateChannelEventRepository,
  generatePrivateChannelEventId,
  type PrivateChannelEventRepository,
  type PrivateChannelEventWriteInput,
} from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { createDbEventSink } from "./sinks/db-sink";
import { createLogEventSink } from "./sinks/log-sink";

export interface PrivateChannelEventInput {
  organizationId: string;
  projectId: string;
  instanceId: string;
  channelId?: string | null;
  sdpUserId?: string | null;
  family: PrivateChannelEventFamily;
  type: PrivateChannelEventType;
  status: PrivateChannelEventStatus;
  payload?: Record<string, unknown>;
  /** Defaults to now. */
  occurredAt?: string;
}

export type PrivateChannelEventRecord = PrivateChannelEventWriteInput;

export interface PrivateChannelEventSink {
  readonly name: string;
  handle(event: PrivateChannelEventRecord): Promise<void> | void;
}

function isoNow(): string {
  return new Date().toISOString();
}

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return redactCredentialSecrets({
      message: error.message,
      name: error.name,
      ...("code" in error ? { code: String((error as { code?: unknown }).code) } : {}),
    }) as Record<string, unknown>;
  }
  return redactCredentialSecrets({ message: String(error) }) as Record<string, unknown>;
}

function toRecord(input: PrivateChannelEventInput): PrivateChannelEventRecord {
  const now = isoNow();
  const payload = redactCredentialSecrets(input.payload ?? {}) as Record<string, unknown>;
  return {
    id: generatePrivateChannelEventId(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    instanceId: input.instanceId,
    channelId: input.channelId ?? null,
    sdpUserId: input.sdpUserId ?? null,
    family: input.family,
    type: input.type,
    status: input.status,
    payload,
    occurredAt: input.occurredAt ?? now,
    createdAt: now,
  };
}

/** Best-effort activity events; sink failures are isolated and never bubble. */
export class PrivateChannelEventService {
  constructor(private readonly sinks: PrivateChannelEventSink[]) {}

  async emit(input: PrivateChannelEventInput): Promise<void> {
    const event = toRecord(input);
    // async wrapper so sync throws still settle as rejections.
    const results = await Promise.allSettled(this.sinks.map(async (sink) => sink.handle(event)));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result?.status === "rejected") {
        const sink = this.sinks[i];
        getLogger().error(
          {
            sink: sink?.name ?? `sink[${i}]`,
            eventId: event.id,
            type: event.type,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
          "private-channel-event sink failed"
        );
      }
    }
  }

  async recordError(
    input: Omit<PrivateChannelEventInput, "family" | "status"> & { error: unknown }
  ): Promise<void> {
    const { error, payload, ...rest } = input;
    await this.emit({
      ...rest,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
      payload: { ...(payload ?? {}), ...normalizeError(error) },
    });
  }
}

export function createPrivateChannelEventService(
  env: Env,
  sinks?: PrivateChannelEventSink[],
  repo?: PrivateChannelEventRepository
): PrivateChannelEventService {
  if (sinks) {
    return new PrivateChannelEventService(sinks);
  }
  const eventRepo = repo ?? createPrivateChannelEventRepository(env);
  return new PrivateChannelEventService([createDbEventSink(eventRepo), createLogEventSink()]);
}
