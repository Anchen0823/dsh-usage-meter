/**
 * DeepSeek API pricing used to bill session usage.
 *
 * All rates are USD per 1M tokens, sourced from the DeepSeek official API
 * docs: https://api-docs.deepseek.com/quick_start/pricing/ (fetched
 * {@link PRICING_FETCHED_AT}). DeepSeek-V4 bills in two input buckets —
 * cache hit (cached input) and cache miss (uncached input) — plus output.
 * Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; all other
 * hours are off-peak and billed at half the peak rate.
 */

/** Official pricing documentation page. */
export const PRICING_SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'

/** Date the built-in table was checked against the official docs. */
export const PRICING_FETCHED_AT = '2026-08-21'

/** One model's official off-peak rates, USD per 1M tokens. */
export interface ModelPrice {
  /** Uncached input (cache miss). */
  readonly inputCacheMiss: number
  /** Cached input (cache hit). */
  readonly inputCacheHit: number
  /** Output tokens. */
  readonly output: number
}

/**
 * Official DeepSeek pricing table, keyed by API model id.
 *
 * `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`
 * are the current lineup. `deepseek-chat` / `deepseek-reasoner` are the
 * archived V3-era ids, kept for older deployments — verify against the
 * official docs before relying on them for new work.
 */
export const DEEPSEEK_PRICING: Readonly<Record<string, ModelPrice>> = {
  // DeepSeek-V4 (current official lineup)
  'deepseek-v4-flash': { inputCacheMiss: 0.22, inputCacheHit: 0.007, output: 0.66 },
  'deepseek-v4-flash-vision-exp': { inputCacheMiss: 0.22, inputCacheHit: 0.007, output: 0.66 },
  'deepseek-v4-pro': { inputCacheMiss: 0.66, inputCacheHit: 0.022, output: 1.98 },
  // Archived DeepSeek-V3 lineup
  'deepseek-chat': { inputCacheMiss: 0.27, inputCacheHit: 0.07, output: 1.1 },
  'deepseek-reasoner': { inputCacheMiss: 0.55, inputCacheHit: 0.14, output: 2.19 },
}

/** Peak rates are twice the off-peak rates. */
export const PEAK_MULTIPLIER = 2

/** JS `getUTCDay()` values for Monday–Friday. */
const PEAK_WEEKDAYS = new Set([1, 2, 3, 4, 5])

/**
 * Whether `timeMs` falls in a DeepSeek peak window: 01:00–04:00 or
 * 06:00–10:00 UTC, Monday through Friday.
 */
export function isPeakHour(timeMs: number): boolean {
  const date = new Date(timeMs)
  if (!PEAK_WEEKDAYS.has(date.getUTCDay())) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** Resolve an official price entry for a model id (exact, then case/prefix tolerant). */
export function resolveModelPrice(model: string): ModelPrice | undefined {
  const exact = DEEPSEEK_PRICING[model]
  if (exact !== undefined) return exact
  const normalized = model.toLowerCase()
  const direct = DEEPSEEK_PRICING[normalized]
  if (direct !== undefined) return direct
  for (const [key, price] of Object.entries(DEEPSEEK_PRICING)) {
    if (normalized.startsWith(key.toLowerCase())) return price
  }
  return undefined
}

/** Per-model user overrides, USD per 1M tokens; partial entries merge over the official table. */
export type ModelPriceOverrides = Readonly<Record<string, Partial<ModelPrice>>>

/** Options controlling how prices are resolved. */
export interface PriceResolverOptions {
  /** Apply DeepSeek peak/off-peak rates by request time. Default true. */
  readonly peakPricing: boolean
  /** Per-model price overrides merged over the official table. */
  readonly overrides: ModelPriceOverrides
}

/**
 * Resolve the effective price for one model at one request time.
 * @param model - model id reported by the route.
 * @param timeMs - request event time; selects peak vs off-peak rates.
 * @returns the effective price, or undefined when no official or override
 *   pricing exists for the model.
 */
export type PriceResolver = (model: string, timeMs: number) => ModelPrice | undefined

/**
 * Build a {@link PriceResolver} from plugin configuration. Overrides fill in
 * or replace the official table per model; a model with no official price
 * must override every bucket it should be billed for (unmentioned buckets
 * price at zero).
 */
export function createPriceResolver(options: PriceResolverOptions): PriceResolver {
  return (model, timeMs): ModelPrice | undefined => {
    const official = resolveModelPrice(model)
    const override = options.overrides[model]
    if (official === undefined && override === undefined) return undefined
    const merged: ModelPrice = {
      inputCacheMiss: override?.inputCacheMiss ?? official?.inputCacheMiss ?? 0,
      inputCacheHit: override?.inputCacheHit ?? official?.inputCacheHit ?? 0,
      output: override?.output ?? official?.output ?? 0,
    }
    const peak = options.peakPricing && isPeakHour(timeMs)
    const scale = peak ? PEAK_MULTIPLIER : 1
    return {
      inputCacheMiss: merged.inputCacheMiss * scale,
      inputCacheHit: merged.inputCacheHit * scale,
      output: merged.output * scale,
    }
  }
}
