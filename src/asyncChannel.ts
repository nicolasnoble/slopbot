/**
 * A simple async channel: push values from one side, consume them
 * as an async iterable from the other.
 *
 * - push(value) — enqueue a value (buffers if no consumer is waiting)
 * - close()     — signal end-of-stream
 * - drain()     — return unconsumed buffered items
 */
export interface AsyncChannel<T> {
  push(value: T): void;
  close(): void;
  drain(): T[];
  closed: boolean;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export function createAsyncChannel<T>(): AsyncChannel<T> {
  const buffer: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  function push(value: T): void {
    if (closed) return;
    // If a consumer is already waiting, resolve it immediately
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      buffer.push(value);
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    // Resolve all waiting consumers with done
    for (const waiter of waiters) {
      waiter({ value: undefined as unknown as T, done: true });
    }
    waiters.length = 0;
  }

  function drain(): T[] {
    const items = buffer.splice(0);
    return items;
  }

  function next(): Promise<IteratorResult<T>> {
    // If there's a buffered value, return it immediately
    if (buffer.length > 0) {
      return Promise.resolve({ value: buffer.shift()!, done: false });
    }
    // If closed, signal end
    if (closed) {
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    }
    // Otherwise, wait for a push or close
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  const channel: AsyncChannel<T> = {
    push,
    close,
    drain,
    get closed() { return closed; },
    [Symbol.asyncIterator]() {
      return { next };
    },
  };

  return channel;
}
