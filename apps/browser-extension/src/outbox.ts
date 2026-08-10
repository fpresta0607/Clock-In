//! Offline resilience for the native-messaging channel. When `connectNative`
//! fails (desktop uninstalled, host missing), span events queue in a bounded
//! FIFO and replay on reconnect, which is retried with
//! exponential backoff. The ring persists to extension storage so a service
//! worker restart does not lose queued verdicts.

export const OUTBOX_CAPACITY = 1000;
export const MAX_RETAINED_OUTBOX_NAMESPACES = 8;
export const OUTBOX_STORAGE_KEY = "spanOutbox";
export const OUTBOX_NAMESPACES_STORAGE_KEY = "spanOutboxesByNamespace";
export const OUTBOX_NAMESPACE_RESERVATIONS_STORAGE_KEY = "spanOutboxNamespaceReservations";

/** A first-in-first-out bounded queue that refuses an item when it is full. */
export class Outbox<T> {
  private items: T[];

  constructor(
    readonly capacity: number = OUTBOX_CAPACITY,
    restore: readonly T[] = [],
  ) {
    this.items = [...restore];
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): boolean {
    if (this.items.length >= this.capacity) {
      return false;
    }
    this.items.push(item);
    return true;
  }

  get remainingCapacity(): number {
    return Math.max(0, this.capacity - this.items.length);
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

export function pruneOutboxNamespaces<T>(
  outboxes: Map<string, Outbox<T>>,
  activeNamespace: string | undefined,
  limit: number = MAX_RETAINED_OUTBOX_NAMESPACES,
  retainedNamespaces: ReadonlySet<string> = new Set(),
): void {
  for (const [namespace, outbox] of outboxes) {
    if (outboxes.size <= limit) {
      return;
    }
    if (namespace !== activeNamespace && outbox.size === 0 && !retainedNamespaces.has(namespace)) {
      outboxes.delete(namespace);
    }
  }
}

export function canActivateOutboxNamespace<T>(
  outboxes: Map<string, Outbox<T>>,
  namespace: string,
  activeNamespace: string | undefined,
  retainedNamespaces: ReadonlySet<string> = new Set(),
): boolean {
  if (outboxes.has(namespace)) {
    return true;
  }
  pruneOutboxNamespaces(outboxes, activeNamespace, MAX_RETAINED_OUTBOX_NAMESPACES - 1, retainedNamespaces);
  return outboxes.size < MAX_RETAINED_OUTBOX_NAMESPACES;
}

/**
 * Reconnect delay after `attempt` consecutive failures: 1 s doubling to a
 * 60 s ceiling, so a missing host is retried forever without hot-looping.
 */
export function reconnectBackoffMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 0), 6);
  return Math.min(60_000, 1000 * 2 ** exponent);
}
