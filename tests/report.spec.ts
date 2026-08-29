import { describe, expect, it } from 'vitest'
import { formatCost, formatUsageCompact, formatUsageReport, type ReportOptions } from '../src/report.ts'
import type { UsageSummary } from '../src/usage.ts'

const options: ReportOptions = {
  currency: 'cny',
  sourceNote: 'DeepSeek 官方人民币价格 — https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ (2026-08-21 抓取)',
  peakPricing: true,
  basePriceOf: () => ({ inputCacheMiss: 1.5, inputCacheHit: 0.05, output: 4.5 }),
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
      costs: { inputMiss: 0.0015, inputHit: 0.0001, output: 0.0022 },
      peakRequests: 1,
      offPeakRequests: 1,
    },
  ],
  totalCost: 0.0038,
  unpricedRoutes: 0,
  completedTurns: 1,
  openTurn: undefined,
  firstEventTime: Date.UTC(2026, 0, 4, 12, 0, 0),
  lastEventTime: Date.UTC(2026, 0, 5, 2, 30, 0),
  skippedSamples: 0,
  unknownRouteSamples: 0,
}

describe('formatCost', () => {
  it('formats CNY with the ¥ symbol', () => {
    expect(formatCost(0.0042, 'cny')).toBe('¥0.0042')
    expect(formatCost(12.5, 'cny')).toBe('¥12.5000')
  })

  it('formats USD with the $ symbol', () => {
    expect(formatCost(0.0042, 'usd')).toBe('$0.0042')
    expect(formatCost(12.5, 'usd')).toBe('$12.5000')
  })
})

describe('formatUsageReport', () => {
  it('renders the headline, meta, and totals', () => {
    const text = formatUsageReport(summary, options)
    expect(text).toContain('📊 1,250 tokens · 2 次请求 · ¥0.0038')
    expect(text).toContain('会话 session-42')
    expect(text).toContain('完成轮次 1')
    expect(text).toContain('时间范围 2026-01-04 12:00:00 UTC ~ 2026-01-05 02:30:00 UTC')
    expect(text).toContain('按请求时间区分高峰/空闲')
    expect(text).toContain('💰 总计 ¥0.0038')
  })

  it('renders per-model detail with rate, buckets, and per-bucket costs', () => {
    const text = formatUsageReport(summary, options)
    expect(text).toContain('🧮 deepseek / deepseek-v4-flash')
    expect(text).toContain('费率 ¥1.5/M 未命中 · ¥0.05/M 命中 · ¥4.5/M 输出')
    expect(text).toContain('输入(未命中)')
    expect(text).toContain('1,000')
    expect(text).toContain('¥0.0015')
    expect(text).toContain('输入(命中)')
    expect(text).toContain('¥0.0001')
    expect(text).toContain('输出')
    expect(text).toContain('¥0.0022')
    expect(text).toContain('推理(含于输出)')
    expect(text).toContain('合计')
    expect(text).toContain('请求 2 次（空闲 1 · 高峰 1） · 缓存命中率 16.7%')
    expect(text).toContain('费用 ¥0.0038')
  })

  it('marks unpriced routes', () => {
    const unpriced: UsageSummary = {
      ...summary,
      totalCost: undefined,
      unpricedRoutes: 1,
      routes: [{ ...summary.routes[0]!, costs: undefined }],
    }
    const text = formatUsageReport(unpriced, options)
    expect(text).toContain('费用 —（该模型暂无价格）')
    expect(text).toContain('💰 总计 —（所有模型均无已知价格，仅统计 token）')
  })

  it('reports a session with no recorded usage', () => {
    const empty: UsageSummary = {
      sessionId: 'session-0',
      totals: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 },
      routes: [],
      totalCost: undefined,
      unpricedRoutes: 0,
      completedTurns: 0,
      openTurn: undefined,
      firstEventTime: undefined,
      lastEventTime: undefined,
      skippedSamples: 0,
      unknownRouteSamples: 0,
    }
    const text = formatUsageReport(empty, options)
    expect(text).toContain('本会话暂无 token 用量记录。')
  })
})

describe('formatUsageCompact', () => {
  it('renders a one-line headline in CNY', () => {
    expect(formatUsageCompact(summary, 'cny')).toBe('1,250 tokens · 2 次请求 · ¥0.0038')
  })

  it('renders a one-line headline in USD', () => {
    expect(formatUsageCompact(summary, 'usd')).toBe('1,250 tokens · 2 次请求 · $0.0038')
  })
})
