/**
 * Human-readable rendering of a session usage summary for the `/usage`
 * command result.
 *
 * The Web Client renders command results as plain monospace text (a `<pre>`
 * block), so the layout uses display-width-aware column alignment (CJK
 * characters count double) and emoji section markers instead of markdown.
 */

import type { Currency, ModelPrice } from './pricing.ts'
import type { RouteUsage, UsageBucket, UsageSummary } from './usage.ts'

const numberFormat = new Intl.NumberFormat('en-US')
const compactNumberFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

const formatTokens = (value: number): string => numberFormat.format(value)

/** Currency symbol. */
export const currencySymbol = (currency: Currency): string => (currency === 'cny' ? '¥' : '$')

/** Render a cost with enough decimals for sub-unit session amounts. */
export function formatCost(value: number, currency: Currency = 'cny'): string {
  return `${currencySymbol(currency)}${value.toFixed(4)}`
}

/** Render a per-1M rate without trailing zeros (e.g. 0.05, 4.5, 0.007). */
function formatRate(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)))
}

/** Display width of one line in a monospace font (CJK and wide glyphs count 2). */
function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += /[^\u0000-\u00FF]/u.test(ch) ? 2 : 1
  return width
}

/** Pad a label to a display width (CJK-aware). */
function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

/** Options that affect the rendered text. */
export interface ReportOptions {
  /** Billing currency; selects the symbol and rate display. */
  readonly currency: Currency
  /** One-line provenance note for the pricing used, e.g. the official docs URL. */
  readonly sourceNote: string
  /** Whether peak/off-peak rates were applied per request time. */
  readonly peakPricing: boolean
  /**
   * Resolve the off-peak base price for one model (used for the per-model
   * rate line). Undefined for models without pricing.
   */
  readonly basePriceOf: (model: string) => ModelPrice | undefined
}

const formatTime = (timeMs: number): string =>
  new Date(timeMs).toISOString().replace(/\.\d{3}Z$/, ' UTC').replace('T', ' ')

const grandTotalTokens = (bucket: UsageBucket): number =>
  bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens + bucket.outputTokens

/** Cache-hit share of total input, as a percentage string (e.g. '99.2'). */
function cacheHitRate(bucket: UsageBucket): string | undefined {
  const input = bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
  if (input <= 0) return undefined
  return ((bucket.cacheReadTokens / input) * 100).toFixed(1)
}

/** One bucket row: label, right-aligned tokens, and per-bucket cost. */
function bucketLine(label: string, value: number, cost: string | undefined): string {
  const costText = cost === undefined ? '' : `  ${cost}`
  return `  ${padTo(label, 16)}${formatTokens(value).padStart(12)}${costText}`
}

function formatRoute(route: RouteUsage, options: ReportOptions): string {
  const known = route.provider.length > 0 && route.model.length > 0
  const label = known ? `${route.provider} / ${route.model}` : '未知路由（无法归因 provider/model）'
  const bucket = route.bucket
  const symbol = currencySymbol(options.currency)
  const costs = route.costs
  const costOf = (component: number): string | undefined =>
    costs === undefined ? undefined : formatCost(component, options.currency)

  const lines: string[] = [`🧮 ${label}`]

  const base = known ? options.basePriceOf(route.model) : undefined
  if (base !== undefined) {
    lines.push(`  费率 ${symbol}${formatRate(base.inputCacheMiss)}/M 未命中 · `
      + `${symbol}${formatRate(base.inputCacheHit)}/M 命中 · `
      + `${symbol}${formatRate(base.output)}/M 输出`)
  }

  lines.push(bucketLine('输入(未命中)', bucket.inputTokens, costOf(costs?.inputMiss ?? 0)))
  lines.push(bucketLine('输入(命中)', bucket.cacheReadTokens, costOf(costs?.inputHit ?? 0)))
  lines.push(bucketLine('输出', bucket.outputTokens, costOf(costs?.output ?? 0)))
  if (bucket.cacheWriteTokens > 0) lines.push(bucketLine('缓存写入', bucket.cacheWriteTokens, undefined))
  if (bucket.reasoningTokens > 0) lines.push(bucketLine('推理(含于输出)', bucket.reasoningTokens, undefined))
  lines.push(bucketLine('合计', grandTotalTokens(bucket), undefined))

  const rate = cacheHitRate(bucket)
  const requests = `请求 ${bucket.requests} 次（空闲 ${route.offPeakRequests} · 高峰 ${route.peakRequests}）`
    + (rate === undefined ? '' : ` · 缓存命中率 ${rate}%`)
  lines.push(`  ${requests}`)
  const total = costs === undefined ? undefined : costs.inputMiss + costs.inputHit + costs.output
  lines.push(`  费用 ${total === undefined ? '—（该模型暂无价格）' : formatCost(total, options.currency)}`)
  return lines.join('\n')
}

/** Render the complete `/usage` report. */
export function formatUsageReport(summary: UsageSummary, options: ReportOptions): string {
  const header = `📊 ${formatUsageCompact(summary, options.currency)}`
  const meta = [
    `  会话 ${summary.sessionId || '未知'}`,
    `  完成轮次 ${summary.completedTurns}`
      + (summary.openTurn !== undefined ? ` · 当前第 ${summary.openTurn} 轮进行中` : ''),
  ]
  if (summary.firstEventTime !== undefined && summary.lastEventTime !== undefined) {
    meta.push(`  时间范围 ${formatTime(summary.firstEventTime)} ~ ${formatTime(summary.lastEventTime)}`)
  }
  meta.push(`  计费 ${options.sourceNote}${options.peakPricing ? ' · 按请求时间区分高峰/空闲' : ''}`)

  const sections: string[] = [header, ...meta]

  if (summary.totals.requests === 0) {
    sections.push('', '  本会话暂无 token 用量记录。')
    return sections.join('\n')
  }

  sections.push('')
  for (const route of summary.routes) sections.push(formatRoute(route, options))

  const grandTotal = grandTotalTokens(summary.totals)
  let totalLine: string
  if (summary.totalCost !== undefined) {
    totalLine = `💰 总计 ${formatCost(summary.totalCost, options.currency)}`
    if (summary.unpricedRoutes > 0) {
      totalLine += `（另有 ${summary.unpricedRoutes} 个模型无价格，仅统计 token）`
    }
  } else if (summary.unpricedRoutes > 0) {
    totalLine = '💰 总计 —（所有模型均无已知价格，仅统计 token）'
  } else {
    totalLine = `💰 总计 ${formatTokens(grandTotal)} tokens`
  }
  sections.push('', totalLine)

  if (summary.skippedSamples > 0) {
    sections.push('', `  注意：${summary.skippedSamples} 条用量样本因计数无效被跳过。`)
  }
  return sections.join('\n')
}

/** Compact one-line summary, used as the report headline. */
export function formatUsageCompact(summary: UsageSummary, currency: Currency = 'cny'): string {
  const grandTotal = grandTotalTokens(summary.totals)
  const cost = summary.totalCost !== undefined ? formatCost(summary.totalCost, currency) : '费用未知'
  return `${formatTokens(grandTotal)} tokens · ${summary.totals.requests} 次请求 · ${cost}`
}
