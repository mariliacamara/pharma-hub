import { describe, it, expect } from '@jest/globals'

import { SlidingWindowLimiter } from '#/modules/kuantokusta/domain/sliding-window-limiter'

function limiterAt(windows: { limit: number, periodMs: number }[]) {
  const clock = { now: 0 }
  return { clock, limiter: new SlidingWindowLimiter(windows, () => clock.now) }
}

describe('SlidingWindowLimiter', () => {
  it('lets calls through until a window is full', () => {
    const { limiter } = limiterAt([{ limit: 3, periodMs: 1000 }])

    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(true)
    expect(limiter.tryAcquire()).toBe(false)
  })

  it('says exactly how long to wait, and no longer', () => {
    const { clock, limiter } = limiterAt([{ limit: 2, periodMs: 1000 }])
    limiter.record()
    clock.now = 300
    limiter.record()
    clock.now = 400

    expect(limiter.delayMs()).toBe(600)

    clock.now = 999
    expect(limiter.delayMs()).toBe(1)

    clock.now = 1000
    expect(limiter.delayMs()).toBe(0)
  })

  it('respects every window at once', () => {
    const { clock, limiter } = limiterAt([
      { limit: 2, periodMs: 1000 },
      { limit: 3, periodMs: 10_000 }
    ])
    limiter.record()
    limiter.record()

    expect(limiter.delayMs()).toBe(1000)

    clock.now = 1000
    limiter.record()
    // The short window has room again; the long one is now full.
    expect(limiter.delayMs()).toBe(9000)
  })

  it('never lets a real sequence exceed any limit', () => {
    const windows = [
      { limit: 4, periodMs: 1000 },
      { limit: 19, periodMs: 10_000 },
      { limit: 29, periodMs: 60_000 }
    ]
    const { clock, limiter } = limiterAt(windows)
    const calls: number[] = []

    for (let i = 0; i < 200; i++) {
      clock.now += limiter.delayMs()
      limiter.record()
      calls.push(clock.now)
    }

    for (const { limit, periodMs } of windows) {
      for (const at of calls) {
        const inWindow = calls.filter((t) => t > at - periodMs && t <= at)

        expect(inWindow.length).toBeLessThanOrEqual(limit)
      }
    }
    // 200 calls at 29 a minute take a little under 7 minutes: it throttles,
    // but does not wait more than the limits require.
    expect(clock.now).toBeGreaterThan(6 * 60_000)
    expect(clock.now).toBeLessThan(7 * 60_000)
  })
})
