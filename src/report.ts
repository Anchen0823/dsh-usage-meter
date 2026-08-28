/**
 * Human-readable rendering of a session usage summary for the `/usage`
 * command result. The output is plain text so every UI (Web GUI and CLI)
 * renders it identically.
 */

import type { RouteUsage, UsageBucket, UsageSummary } from './usage.ts'

const numberFormat = new Intl.NumberFormat('en-US')
const compactNumberFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

const formatTokens = (value: number): string => numberFormat.format(value)

/** Render a USD amount with enough decimals for sub-cent session costs. */
export function formatCost(value: number): string {
  return `$${value.toFixed(4)}`
}

/** Options that affect the rendered text. */
export interface ReportOptions {
  /** One-line provenance note for the pricing used, e.g. the official docs URL. */
  readonly sourceNote: string
  /** Whether peak/off-peak rates were applied per request time. */
  readonly peakPricing: boolean
}

const formatTime = (timeMs: number): string =>
  new Date(timeMs).toISOString().replace(/\.\d{3}Z$/, ' UTC').replace('T', ' ')

function formatBucket(bucket: UsageBucket): string {
  const column = (label: string): string => `    ${label.padEnd(20)}`
  const lines = [
    `${column('input (cache miss):')}${formatTokens(bucket.inputTokens)}`,
    `${column('input (cache hit):')}${formatTokens(bucket.cacheReadTokens)}`,
    `${column('output:')}${formatTokens(bucket.outputTokens)}`,
  ]
  if (bucket.cacheWriteTokens > 0) {
    lines.push(`${column('cache write:')}${formatTokens(bucket.cacheWriteTokens)}`)
  }
  if (bucket.reasoningTokens > 0) {
    lines.push(`${column('reasoning:')}${formatTokens(bucket.reasoningTokens)}`)
  }
  const total = bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens + bucket.outputTokens
  lines.push(`${column('total tokens:')}${formatTokens(total)}`)
  return lines.join('\n')
}

function formatRoute(route: RouteUsage): string {
  const label = route.provider.length > 0 && route.model.length > 0
    ? `${route.provider} / ${route.model}`
    : 'unknown route (provider/model not attributed)'
  const requests = `requests: ${route.bucket.requests}`
    + ` (${route.offPeakRequests} off-peak, ${route.peakRequests} peak)`
  const costLine = route.costUsd !== undefined
    ? `    cost: ${formatCost(route.costUsd)}`
    : '    cost: — (no pricing known for this model)'
  return [
    `  ${label}`,
    formatBucket(route.bucket),
    `    ${requests}`,
    costLine,
  ].join('\n')
}

/** Render the complete `/usage` report. */
export function formatUsageReport(summary: UsageSummary, options: ReportOptions): string {
  const header = [
    `Token usage and API cost for session ${summary.sessionId || '(unknown)'}`,
  ]
  const meta = [
    `completed turns: ${summary.completedTurns}`
    + `${summary.openTurn !== undefined ? ` · current turn ${summary.openTurn} in progress` : ''}`,
    `billed requests: ${summary.totals.requests}`
    + (summary.unknownRouteSamples > 0 ? ` · ${summary.unknownRouteSamples} sample(s) without route attribution` : ''),
  ]
  if (summary.firstEventTime !== undefined && summary.lastEventTime !== undefined) {
    meta.push(`first event: ${formatTime(summary.firstEventTime)} · last event: ${formatTime(summary.lastEventTime)}`)
  }
  meta.push(`pricing: ${options.sourceNote}${options.peakPricing ? ' · peak/off-peak applied per request time' : ''}`)

  const sections: string[] = [header.join('\n'), ...meta.map(line => `  ${line}`)]

  if (summary.totals.requests === 0) {
    sections.push('', 'No provider token usage has been recorded for this session yet.')
  } else {
    sections.push('', 'Per model:')
    for (const route of summary.routes) sections.push(formatRoute(route))
    const total = summary.totals
    const grandTotal = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens + total.outputTokens
    let totalCost = ''
    if (summary.totalCostUsd !== undefined) {
      totalCost = ` · cost ${formatCost(summary.totalCostUsd)}`
      if (summary.unpricedRoutes > 0) {
        totalCost += ` (${summary.unpricedRoutes} unpriced route(s); tokens only)`
      }
    } else if (summary.unpricedRoutes > 0) {
      totalCost = ' · cost unknown (no pricing for any route)'
    }
    sections.push('', `Total: ${formatTokens(grandTotal)} tokens${totalCost}`)
  }

  if (summary.skippedSamples > 0) {
    sections.push('', `Note: ${summary.skippedSamples} usage sample(s) were skipped because their counts were invalid.`)
  }
  return sections.join('\n')
}

/** Compact one-line summary, useful for short status lines. */
export function formatUsageCompact(summary: UsageSummary): string {
  const total = summary.totals
  const grandTotal = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens + total.outputTokens
  const cost = summary.totalCostUsd !== undefined ? `, ${formatCost(summary.totalCostUsd)}` : ''
  return `${compactNumberFormat.format(grandTotal)} tokens, ${summary.completedTurns} turn(s), `
    + `${summary.totals.requests} request(s)${cost}`
}
