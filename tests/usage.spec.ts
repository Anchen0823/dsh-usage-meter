import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { createPriceResolver, type PriceResolver } from '../src/pricing.ts'
import { deriveSessionUsage } from '../src/usage.ts'

// Off-peak (Sunday 2026-01-04 12:00 UTC) and peak (Monday 2026-01-05 02:30 UTC) times.
const OFF_PEAK = Date.UTC(2026, 0, 4, 12, 0, 0)
const PEAK = Date.UTC(2026, 0, 5, 2, 30, 0)

type EventData = Record<string, unknown>

/** Minimal session-log builder: seq stays contiguous per log. */
class Log {
  readonly events: SessionEvent[] = []

  private push(type: string, data: EventData, time: number): void {
    this.events.push({ type, data, seq: this.events.length, time } as unknown as SessionEvent)
  }

  turnStart(turn: number, time = OFF_PEAK): this { this.push('turn/start', { turn }, time); return this }
  turnEnd(turn: number, time = OFF_PEAK): this { this.push('turn/end', { turn }, time); return this }
  usageChunk(turn: number, step: number, usage: TokenUsage, time = OFF_PEAK): this {
    this.push('assistant/chunk', { turn, step, chunk: { type: 'usage', usage } }, time)
    return this
  }
  assistantMessage(turn: number, step: number, provider: string, model: string, usage: TokenUsage, time = OFF_PEAK): this {
    this.push('assistant/message', {
      turn,
      step,
      message: { role: 'assistant', content: [], source: { provider, model } },
      usage,
    }, time)
    return this
  }
  retryStarted(turn: number, step: number, time = OFF_PEAK): this {
    this.push('llm/retry-started', { turn, step }, time)
    return this
  }
  requestContext(provider: string, model: string, time = OFF_PEAK): this {
    this.push('request/context', { provider, model }, time)
    return this
  }
}

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 100,
  outputTokens: 20,
  ...overrides,
})

/** Price 1 USD / 1M for every bucket of any model, time-independent. */
const flatResolver: PriceResolver = () => ({ inputCacheMiss: 1, inputCacheHit: 1, output: 1 })

describe('deriveSessionUsage', () => {
  it('returns an empty summary for an empty log', () => {
    const summary = deriveSessionUsage([], flatResolver)
    expect(summary.totals).toMatchObject({ inputTokens: 0, outputTokens: 0, requests: 0 })
    expect(summary.routes).toEqual([])
    expect(summary.completedTurns).toBe(0)
    expect(summary.openTurn).toBeUndefined()
    expect(summary.totalCostUsd).toBeUndefined()
  })

  it('accumulates usage chunks into a route', () => {
    const summary = deriveSessionUsage(new Log()
      .turnStart(1).usageChunk(1, 1, usage()).turnEnd(1)
      .turnStart(2).usageChunk(2, 1, usage({ inputTokens: 50, outputTokens: 5 })).turnEnd(2)
      .events, flatResolver)
    expect(summary.completedTurns).toBe(2)
    expect(summary.totals.inputTokens).toBe(150)
    expect(summary.totals.outputTokens).toBe(25)
    expect(summary.totals.requests).toBe(2)
    expect(summary.routes).toHaveLength(1)
    expect(summary.routes[0]!).toMatchObject({ provider: '', model: '' })
    expect(summary.unknownRouteSamples).toBe(2)
  })

  it('does not double-count a chunk sample replaced by the final message usage', () => {
    const summary = deriveSessionUsage(new Log()
      .turnStart(1)
      .usageChunk(1, 1, usage({ inputTokens: 100, outputTokens: 20 }))
      .assistantMessage(1, 1, 'deepseek', 'deepseek-v4-flash', usage({ inputTokens: 120, outputTokens: 25 }))
      .turnEnd(1)
      .events, flatResolver)
    expect(summary.totals.inputTokens).toBe(120)
    expect(summary.totals.outputTokens).toBe(25)
    expect(summary.totals.requests).toBe(1)
    expect(summary.routes[0]!).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  it('counts a retried attempt separately', () => {
    const summary = deriveSessionUsage(new Log()
      .turnStart(1)
      .usageChunk(1, 1, usage())
      .retryStarted(1, 1)
      .usageChunk(1, 1, usage({ inputTokens: 200, outputTokens: 40 }))
      .turnEnd(1)
      .events, flatResolver)
    expect(summary.totals.inputTokens).toBe(300)
    expect(summary.totals.requests).toBe(2)
  })

  it('falls back to the latest request context for chunk-only attempts', () => {
    const summary = deriveSessionUsage(new Log()
      .requestContext('deepseek', 'deepseek-v4-flash')
      .turnStart(1).usageChunk(1, 1, usage()).turnEnd(1)
      .events, flatResolver)
    expect(summary.routes[0]!).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    expect(summary.unknownRouteSamples).toBe(0)
  })

  it('keeps different routes separate', () => {
    const summary = deriveSessionUsage(new Log()
      .requestContext('deepseek', 'deepseek-v4-flash')
      .turnStart(1).usageChunk(1, 1, usage()).turnEnd(1)
      .requestContext('other', 'gpt-5')
      .turnStart(2).usageChunk(2, 1, usage({ inputTokens: 7 })).turnEnd(2)
      .events, flatResolver)
    expect(summary.routes).toHaveLength(2)
    expect(summary.routes.map(route => route.model)).toEqual(['deepseek-v4-flash', 'gpt-5'])
    expect(summary.totals.inputTokens).toBe(107)
  })

  it('tracks the open turn', () => {
    const summary = deriveSessionUsage(new Log()
      .turnStart(1).usageChunk(1, 1, usage()).turnEnd(1)
      .turnStart(2).usageChunk(2, 1, usage())
      .events, flatResolver)
    expect(summary.completedTurns).toBe(1)
    expect(summary.openTurn).toBe(2)
  })

  it('skips invalid usage samples', () => {
    const summary = deriveSessionUsage(new Log()
      .turnStart(1)
      .usageChunk(1, 1, usage({ inputTokens: -5 }))
      .usageChunk(1, 1, usage({ reasoningTokens: 999 }))
      .assistantMessage(1, 1, 'deepseek', 'deepseek-v4-flash', usage())
      .turnEnd(1)
      .events, flatResolver)
    expect(summary.skippedSamples).toBe(2)
    expect(summary.totals.inputTokens).toBe(100)
    expect(summary.totals.requests).toBe(1)
  })

  it('computes cost with a known model and peak doubling', () => {
    const resolver = createPriceResolver({ peakPricing: true, overrides: {} })
    const log = new Log()
      .turnStart(1)
      .assistantMessage(1, 1, 'deepseek', 'deepseek-v4-flash',
        usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), OFF_PEAK)
      .assistantMessage(1, 2, 'deepseek', 'deepseek-v4-flash',
        usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), PEAK)
      .turnEnd(1)
    const summary = deriveSessionUsage(log.events, resolver)
    // Off-peak: 0.22 (miss) + 0.66 (output) = 0.88; peak doubles to 1.76. Total 2.64.
    expect(summary.totalCostUsd).toBeCloseTo(2.64, 6)
    expect(summary.routes[0]!.peakRequests).toBe(1)
    expect(summary.routes[0]!.offPeakRequests).toBe(1)
  })

  it('leaves cost undefined for unknown models', () => {
    const summary = deriveSessionUsage(new Log()
      .requestContext('openai', 'gpt-5')
      .turnStart(1).usageChunk(1, 1, usage()).turnEnd(1)
      .events, createPriceResolver({ peakPricing: true, overrides: {} }))
    expect(summary.totalCostUsd).toBeUndefined()
    expect(summary.unpricedRoutes).toBe(1)
    expect(summary.routes[0]!.costUsd).toBeUndefined()
  })

  it('reports the event time range', () => {
    const summary = deriveSessionUsage(new Log()
      .turnStart(1).usageChunk(1, 1, usage()).turnEnd(1)
      .events, flatResolver)
    expect(summary.firstEventTime).toBe(OFF_PEAK)
    expect(summary.lastEventTime).toBe(OFF_PEAK)
  })
})
