import type {
  PrivateChannelEventRepository,
  PrivateChannelEventWriteInput,
} from "@/db/repositories/private-channel-event.repository";
import type { PrivateChannelEventSink } from "@/services/private-channels/event.service";

export function createDbEventSink(repo: PrivateChannelEventRepository): PrivateChannelEventSink {
  return {
    name: "db",
    async handle(event: PrivateChannelEventWriteInput) {
      await repo.insert(event);
    },
  };
}
