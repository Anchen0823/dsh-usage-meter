import { describe, expect, it } from 'vitest'
import { formatCost, formatUsageCompact, formatUsageReport } from '../src/report.ts'
import type { UsageSummary } from '../src/usage.ts'

const options = {
  sourceNote: 'DeepSeek official pricing — https://api-docs.deepseek.com/quick_start/pricing/ (fetched 2026-08-21)',
  peakPricing: true,
}

const summary: UsageSummary = {
  sessionId: 'session-42',
  totals: {
    inputTokens: 1000,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
    outputTokens: 50,
    reasoningTokens: 10,
    requests: 2,
  },
  routes: [
    {
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      bucket: {
        inputTokens: 1000,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        outputTokens: 50,
        reasoningTokens: 10,
        requests: 2,
      },
      costUsd: 0.0042,
      peakRequests: 1,
      offPeakRequests: 1,
    },
  ],
  totalCostUsd: 0.0042,
  unpricedRoutes: 0,
  completedTurns: 1,
  openTurn: undefined,
  firstEventTime: Date.UTC(2026, 0, 4, 12, 0, 0),
  lastEventTime: Date.UTC(2026, 0, 5, 2, 30, 0),
  skippedSamples: 0,
  unknownRouteSamples: 0,
}

describe('formatCost', () => {
  it('formats sub-cent amounts with four decimals', () => {
    expect(formatCost(0.0042)).toBe('$0.0042')
    expect(formatCost(12.5)).toBe('$12.5000')
  })
})

describe('formatUsageReport', () => {
  it('renders session identity and totals', () => {
    const text = formatUsageReport(summary, options)
    expect(text).toContain('Token usage and API cost for session session-42')
    expect(text).toContain('completed turns: 1')
    expect(text).toContain('billed requests: 2')
    expect(text).toContain('first event: 2026-01-04 12:00:00 UTC')
    expect(text).toContain('peak/off-peak applied per request time')
  })

  it('renders per-model detail with cost', () => {
    const text = formatUsageReport(summary, options)
    expect(text).toContain('deepseek / deepseek-v4-flash')
    expect(text).toContain('input (cache miss): 1,000')
    expect(text).toContain('input (cache hit):  200')
    expect(text).toContain('output:             50')
    expect(text).toContain('reasoning:          10')
    expect(text).toContain('total tokens:       1,250')
    expect(text).toContain('requests: 2 (1 off-peak, 1 peak)')
    expect(text).toContain('cost: $0.0042')
    expect(text).toContain('Total: 1,250 tokens · cost $0.0042')
  })

  it('marks unpriced routes', () => {
    const unpriced: UsageSummary = {
      ...summary,
      totalCostUsd: undefined,
      unpricedRoutes: 1,
      routes: [{
        ...summary.routes[0]!,
        costUsd: undefined,
      }],
    }
    const text = formatUsageReport(unpriced, options)
    expect(text).toContain('cost: — (no pricing known for this model)')
    expect(text).toContain('Total: 1,250 tokens · cost unknown (no pricing for any route)')
  })

  it('reports a session with no recorded usage', () => {
    const empty: UsageSummary = {
      sessionId: 'session-0',
      totals: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 },
      routes: [],
      totalCostUsd: undefined,
      unpricedRoutes: 0,
      completedTurns: 0,
      openTurn: undefined,
      firstEventTime: undefined,
      lastEventTime: undefined,
      skippedSamples: 0,
      unknownRouteSamples: 0,
    }
    const text = formatUsageReport(empty, options)
    expect(text).toContain('No provider token usage has been recorded for this session yet.')
  })
})

describe('formatUsageCompact', () => {
  it('renders a one-line summary', () => {
    expect(formatUsageCompact(summary)).toBe('1.25K tokens, 1 turn(s), 2 request(s), $0.0042')
  })
})
