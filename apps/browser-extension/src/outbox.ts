//! Offline resilience for the native-messaging channel. When `connectNative`
//! fails (desktop uninstalled, host missing), span events queue in a bounded
//! ring — oldest dropped — and replay on reconnect, which is retried with
//! exponential backoff. The ring persists to extension storage so a service
//! worker restart does not lose queued verdicts.

export const OUTBOX_CAPACITY = 1000;
export const OUTBOX_STORAGE_KEY = "spanOutbox";
export const OUTBOX_NAMESPACES_STORAGE_KEY = "spanOutboxesByNamespace";

/** A first-in-first-out bounded queue; pushing past capacity drops the oldest. */
export class Outbox<T> {
  private items: T[];

  constructor(
    readonly capacity: number = OUTBOX_CAPACITY,
    restore: readonly T[] = [],
  ) {
    this.items = restore.slice(-capacity);
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /** Returns every queued item in order and empties the ring. */
  drain(): T[] {
    const drained = this.items;
    this.items = [];
    return drained;
  }

  clear(): void {
    this.items = [];
  }

  remove(predicate: (item: T) => boolean): boolean {
    const index = this.items.findIndex(predicate);
    if (index === -1) {
      return false;
    }
    this.items.splice(index, 1);
    return true;
  }

  /** Storage snapshot, oldest first. */
  snapshot(): T[] {
    return [...this.items];
  }
}

/**
 * Reconnect delay after `attempt` consecutive failures: 1 s doubling to a
 * 60 s ceiling, so a missing host is retried forever without hot-looping.
 */
export function reconnectBackoffMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 0), 6);
  return Math.min(60_000, 1000 * 2 ** exponent);
}
