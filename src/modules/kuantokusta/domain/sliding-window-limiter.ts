/**
 * Keeps a caller under several "at most N calls per period" limits at once.
 *
 * The Seller API allows 5 requests per second, 20 per 10 seconds and 30 per
 * minute, per key, and blocks the key for 30 seconds when any is exceeded.
 * Staying under them is cheaper than recovering from a block.
 *
 * The count lives in this process. With more than one instance of the
 * service each would count on its own; the 429 handling in the client is
 * the safety net for that.
 */
export interface RateWindow {
  limit: number
  periodMs: number
}

export class SlidingWindowLimiter {
  private readonly longestMs: number
  private calls: number[] = []

  constructor(
    private readonly windows: readonly RateWindow[],
    private readonly now: () => number = Date.now
  ) {
    this.longestMs = Math.max(...windows.map((window) => window.periodMs))
  }

  /** How long to wait before the next call fits every window. 0 = now. */
  delayMs(): number {
    const now = this.now()
    this.forgetOlderThan(now - this.longestMs)

    let delay = 0
    for (const { limit, periodMs } of this.windows) {
      const inWindow = this.calls.filter((at) => at > now - periodMs)
      if (inWindow.length >= limit) {
        // The call fits once the oldest call that still counts has left.
        const leaves = inWindow[inWindow.length - limit] + periodMs
        delay = Math.max(delay, leaves - now)
      }
    }
    return delay
  }

  /** Counts one call made now. */
  record(): void {
    this.calls.push(this.now())
  }

  /** Counts a call if it fits right now; says whether it did. */
  tryAcquire(): boolean {
    if (this.delayMs() > 0) return false
    this.record()
    return true
  }

  private forgetOlderThan(cutoff: number): void {
    if (this.calls.length > 0 && this.calls[0] <= cutoff) {
      this.calls = this.calls.filter((at) => at > cutoff)
    }
  }
}
