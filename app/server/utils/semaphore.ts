/**
 * Async semaphore — replaces Python's threading.BoundedSemaphore. Because the
 * JS event loop is single-threaded there is no lock; run() just queues work and
 * caps concurrent executions. Supports setMax() for hot-reload (Phase 4).
 */
export class AsyncSemaphore {
  private waiters: Array<() => void> = []
  private active = 0

  constructor(private max: number) {}

  get capacity(): number {
    return this.max
  }

  setMax(n: number): void {
    this.max = Math.max(1, Math.floor(n))
    this.pump()
  }

  /** Run `fn` once a slot is free. Serializes on capacity like the BoundedSemaphore did. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // Contended: pump() grants the slot by incrementing `active` and *then*
      // resolving us, so on resume we must NOT increment again — doing so would
      // double-count the permit and leak it (active grows past max forever,
      // deadlocking every later caller). Only the uncontended path increments.
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    } else {
      this.active++
    }
    try {
      return await fn()
    } finally {
      this.active--
      this.pump()
    }
  }

  private pump(): void {
    while (this.active < this.max && this.waiters.length > 0) {
      this.active++ // grant: count the slot before handing it to the waiter
      const next = this.waiters.shift()!
      next()
    }
  }
}
