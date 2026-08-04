import type {
  PrivateChannelEventRepository,
  PrivateChannelEventWriteInput,
} from "@/db/repositories";
import type { PrivateChannelEventSink } from "../event.service";

export function createDbEventSink(repo: PrivateChannelEventRepository): PrivateChannelEventSink {
  return {
    name: "db",
    async handle(event: PrivateChannelEventWriteInput) {
      await repo.insert(event);
    },
  };
}
