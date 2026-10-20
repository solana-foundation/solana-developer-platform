/**
 * A Map that holds at most `capacity` entries, evicting the least recently
 * used one when a new key would exceed it. Reads refresh recency. For small
 * per-instance state (rate-limit fallbacks, refusal caches) whose memory must
 * stay bounded however many distinct keys callers send.
 */
export class BoundedLruMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("BoundedLruMap capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}
