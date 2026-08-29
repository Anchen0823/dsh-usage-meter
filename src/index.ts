/**
 * dsh-usage-meter — per-session token usage and DeepSeek API cost.
 *
 * Registers the human `/usage` command. Invoking it derives exact
 * provider-reported token usage from the receiving agent's session log and
 * bills it with the official DeepSeek pricing (see `pricing.ts`), applying
 * peak/off-peak rates per request time. Costs are reported in the configured
 * currency (default 人民币/CNY).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'
import {
  createPriceResolver,
  PRICING_FETCHED_AT,
  PRICING_SOURCE_URL,
  PRICING_SOURCE_URL_CNY,
  type Currency,
  type ModelPrice,
  type ModelPriceOverrides,
} from './pricing.ts'
import { formatUsageReport } from './report.ts'
import { deriveSessionUsage } from './usage.ts'

export const name = 'usage-meter'
export const inject = ['commands']

/** Plugin configuration. */
export interface UsageMeterConfig {
  /**
   * Billing currency; selects the official price table and the report
   * symbol. Default `cny` (人民币).
   */
  readonly currency?: Currency
  /**
   * Apply DeepSeek peak/off-peak rates per request time (peak = 2× off-peak;
   * peak hours are 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri). Default true.
   */
  readonly peakPricing?: boolean
  /**
   * Per-model price overrides (per 1M tokens, in the selected currency),
   * merged over the official table. A model with no official price must
   * override every bucket it should be billed for.
   */
  readonly priceOverrides?: ModelPriceOverrides
}

/** Validate plugin configuration (schema-driven defaults). */
export const Config: Schema<UsageMeterConfig> = Schema.object({
  currency: Schema.union(['cny', 'usd']).default('cny'),
  peakPricing: Schema.boolean().default(true),
  priceOverrides: Schema.dict(Schema.object({
    inputCacheMiss: Schema.number().min(0),
    inputCacheHit: Schema.number().min(0),
    output: Schema.number().min(0),
  })).default({}),
})

const DEFAULT_CONFIG: Required<UsageMeterConfig> = {
  currency: 'cny',
  peakPricing: true,
  priceOverrides: {},
}

/**
 * Mount the `/usage` command.
 * @param ctx - context carrying the human-command registry.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: UsageMeterConfig = {}): void {
  const resolved: Required<UsageMeterConfig> = {
    currency: config.currency ?? DEFAULT_CONFIG.currency,
    peakPricing: config.peakPricing ?? DEFAULT_CONFIG.peakPricing,
    priceOverrides: config.priceOverrides ?? DEFAULT_CONFIG.priceOverrides,
  }
  const resolver = createPriceResolver({
    currency: resolved.currency,
    peakPricing: resolved.peakPricing,
    overrides: resolved.priceOverrides,
  })
  const offPeakResolver = createPriceResolver({
    currency: resolved.currency,
    peakPricing: false,
    overrides: resolved.priceOverrides,
  })
  const basePriceOf = (model: string): ModelPrice | undefined => offPeakResolver(model, 0)
  const sourceNote = resolved.currency === 'cny'
    ? `DeepSeek 官方人民币价格 — ${PRICING_SOURCE_URL_CNY} (${PRICING_FETCHED_AT} 抓取)`
    : `DeepSeek official pricing — ${PRICING_SOURCE_URL} (fetched ${PRICING_FETCHED_AT})`

  ctx.effect(() => ctx.commands.register({
    name: 'usage',
    description: 'Show token usage and DeepSeek API cost for the current session',
    handler: (invocation): CommandResult => {
      const session = invocation.agent.session
      const summary = deriveSessionUsage(session.events, resolver)
      return {
        kind: 'success',
        text: formatUsageReport({ ...summary, sessionId: session.id }, {
          currency: resolved.currency,
          sourceNote,
          peakPricing: resolved.peakPricing,
          basePriceOf,
        }),
      }
    },
  }), 'dsh-usage-meter: command')
}

export type { Currency, ModelPrice, ModelPriceOverrides }
