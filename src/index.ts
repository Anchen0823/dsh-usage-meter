/**
 * dsh-usage-meter — per-session token usage and DeepSeek API cost.
 *
 * Registers the human `/usage` command. Invoking it derives exact
 * provider-reported token usage from the receiving agent's session log and
 * bills it with the official DeepSeek pricing (see `pricing.ts`), applying
 * peak/off-peak rates per request time.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'
import {
  createPriceResolver,
  PRICING_FETCHED_AT,
  PRICING_SOURCE_URL,
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
   * Apply DeepSeek peak/off-peak rates per request time (peak = 2× off-peak;
   * peak hours are 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri). Default true.
   */
  readonly peakPricing?: boolean
  /**
   * Per-model USD price overrides (per 1M tokens), merged over the official
   * table. A model with no official price must override every bucket it
   * should be billed for.
   */
  readonly priceOverrides?: ModelPriceOverrides
}

/** Validate plugin configuration (schema-driven defaults). */
export const Config: Schema<UsageMeterConfig> = Schema.object({
  peakPricing: Schema.boolean().default(true),
  priceOverrides: Schema.dict(Schema.object({
    inputCacheMiss: Schema.number().min(0),
    inputCacheHit: Schema.number().min(0),
    output: Schema.number().min(0),
  })).default({}),
})

const DEFAULT_CONFIG: Required<UsageMeterConfig> = {
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
    peakPricing: config.peakPricing ?? DEFAULT_CONFIG.peakPricing,
    priceOverrides: config.priceOverrides ?? DEFAULT_CONFIG.priceOverrides,
  }
  const resolver = createPriceResolver({
    peakPricing: resolved.peakPricing,
    overrides: resolved.priceOverrides,
  })

  ctx.effect(() => ctx.commands.register({
    name: 'usage',
    description: 'Show token usage and DeepSeek API cost for the current session',
    handler: (invocation): CommandResult => {
      const session = invocation.agent.session
      const summary = deriveSessionUsage(session.events, resolver)
      return {
        kind: 'success',
        text: formatUsageReport({ ...summary, sessionId: session.id }, {
          sourceNote: `DeepSeek official pricing — ${PRICING_SOURCE_URL} (fetched ${PRICING_FETCHED_AT})`,
          peakPricing: resolved.peakPricing,
        }),
      }
    },
  }), 'dsh-usage-meter: command')
}

export type { ModelPrice, ModelPriceOverrides }
