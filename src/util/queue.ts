/** Single-consumer async queue used to merge agent updates and tool events. */
export class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
