import { PRIVATE_CHANNEL_EVENT_FAMILIES } from "@sdp/types";
import { getLogger } from "@/runtime/logger";
import type { PrivateChannelEventSink } from "../event.service";

/** Console sink for private channel events. */
export function createLogEventSink(): PrivateChannelEventSink {
  return {
    name: "log",
    handle(event) {
      const line = {
        scope: "private-channel-event",
        id: event.id,
        family: event.family,
        type: event.type,
        status: event.status,
        instanceId: event.instanceId,
        channelId: event.channelId,
      };
      if (event.family === PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR) {
        getLogger().error(line, "private-channel event");
        return;
      }
      getLogger().info(line, "private-channel event");
    },
  };
}
