import { type ClusterScope, currentClusterScope } from "@sdp/rpc/scope";
import type { Mock } from "vitest";

/**
 * Record the cluster scope each later call to `service` runs in, while its current answer still
 * answers. Services read the environment and cluster from the open scope rather than taking them
 * as arguments, so a route test asserts the scope a mocked service ran in.
 *
 * @param service - A mocked service whose answer is already set.
 * @returns The scopes of the calls made from now on, in call order.
 * @throws Error when `service` has no answer to keep.
 */
export function recordCallScopes(service: Mock): ClusterScope[] {
  const answer = service.getMockImplementation();
  if (answer === undefined) {
    throw new Error("recordCallScopes needs the mocked service's answer set first");
  }
  const scopes: ClusterScope[] = [];
  service.mockImplementation((...args: unknown[]) => {
    scopes.push(currentClusterScope());
    return answer(...args);
  });
  return scopes;
}
