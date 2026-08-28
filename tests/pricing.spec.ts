import { describe, expect, it } from 'vitest'
import {
  createPriceResolver,
  DEEPSEEK_PRICING,
  isPeakHour,
  PRICING_FETCHED_AT,
  resolveModelPrice,
  type ModelPrice,
} from '../src/pricing.ts'

// Weekday helpers: 2026-01-01 is a Thursday.
const sunday = Date.UTC(2026, 0, 4, 12, 0, 0)
const monday = Date.UTC(2026, 0, 5, 2, 30, 0)
const friday = Date.UTC(2026, 0, 9, 3, 0, 0)
const saturday = Date.UTC(2026, 0, 10, 2, 0, 0)

describe('DEEPSEEK_PRICING', () => {
  it('covers the current official DeepSeek-V4 lineup', () => {
    expect(DEEPSEEK_PRICING['deepseek-v4-flash']).toEqual({
      inputCacheMiss: 0.22,
      inputCacheHit: 0.007,
      output: 0.66,
    })
    expect(DEEPSEEK_PRICING['deepseek-v4-pro']).toEqual({
      inputCacheMiss: 0.66,
      inputCacheHit: 0.022,
      output: 1.98,
    })
    expect(DEEPSEEK_PRICING['deepseek-v4-flash-vision-exp']).toEqual(DEEPSEEK_PRICING['deepseek-v4-flash'])
  })

  it('keeps the archived V3 ids for older deployments', () => {
    expect(DEEPSEEK_PRICING['deepseek-chat']).toBeDefined()
    expect(DEEPSEEK_PRICING['deepseek-reasoner']).toBeDefined()
  })

  it('records when the table was fetched', () => {
    expect(PRICING_FETCHED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('isPeakHour', () => {
  it('treats weekend hours as off-peak', () => {
    expect(isPeakHour(sunday)).toBe(false)
    expect(isPeakHour(saturday)).toBe(false)
  })

  it('treats the 01:00–04:00 UTC weekday window as peak', () => {
    expect(isPeakHour(monday)).toBe(true)
    expect(isPeakHour(friday)).toBe(true)
    expect(isPeakHour(Date.UTC(2026, 0, 5, 0, 59, 0))).toBe(false)
    expect(isPeakHour(Date.UTC(2026, 0, 5, 4, 0, 0))).toBe(false)
  })

  it('treats the 06:00–10:00 UTC weekday window as peak', () => {
    expect(isPeakHour(Date.UTC(2026, 0, 5, 6, 30, 0))).toBe(true)
    expect(isPeakHour(Date.UTC(2026, 0, 5, 9, 59, 0))).toBe(true)
    expect(isPeakHour(Date.UTC(2026, 0, 5, 10, 0, 0))).toBe(false)
  })

  it('treats other weekday hours as off-peak', () => {
    expect(isPeakHour(Date.UTC(2026, 0, 5, 12, 0, 0))).toBe(false)
    expect(isPeakHour(Date.UTC(2026, 0, 5, 4, 30, 0))).toBe(false)
  })
})

describe('resolveModelPrice', () => {
  it('resolves exact ids', () => {
    expect(resolveModelPrice('deepseek-v4-flash')).toEqual(DEEPSEEK_PRICING['deepseek-v4-flash'])
  })

  it('is case-insensitive', () => {
    expect(resolveModelPrice('DeepSeek-V4-Flash')).toEqual(DEEPSEEK_PRICING['deepseek-v4-flash'])
  })

  it('falls back to a known prefix', () => {
    expect(resolveModelPrice('deepseek-v4-flash-0731')).toEqual(DEEPSEEK_PRICING['deepseek-v4-flash'])
  })

  it('returns undefined for unknown models', () => {
    expect(resolveModelPrice('gpt-5')).toBeUndefined()
  })
})

describe('createPriceResolver', () => {
  const base: ModelPrice = { inputCacheMiss: 1, inputCacheHit: 0.5, output: 2 }
  const resolverFor = (overrides: Record<string, Partial<ModelPrice>>, peakPricing = true) =>
    createPriceResolver({ peakPricing, overrides })

  it('doubles prices in a peak window', () => {
    const resolver = resolverFor({})
    const offPeak = resolver('deepseek-v4-flash', sunday)
    const peak = resolver('deepseek-v4-flash', monday)
    expect(offPeak).toEqual(DEEPSEEK_PRICING['deepseek-v4-flash'])
    expect(peak).toEqual({
      inputCacheMiss: 0.44,
      inputCacheHit: 0.014,
      output: 1.32,
    })
  })

  it('can disable peak pricing', () => {
    const resolver = resolverFor({}, false)
    expect(resolver('deepseek-v4-flash', monday)).toEqual(DEEPSEEK_PRICING['deepseek-v4-flash'])
  })

  it('merges partial overrides over the official table', () => {
    const resolver = resolverFor({ 'deepseek-v4-flash': { output: 0.5 } })
    expect(resolver('deepseek-v4-flash', sunday)).toEqual({
      inputCacheMiss: 0.22,
      inputCacheHit: 0.007,
      output: 0.5,
    })
  })

  it('prices an override-only model from its own buckets', () => {
    const resolver = resolverFor({ 'my-model': base })
    expect(resolver('my-model', sunday)).toEqual(base)
  })

  it('returns undefined when no official or override price exists', () => {
    const resolver = resolverFor({})
    expect(resolver('gpt-5', sunday)).toBeUndefined()
  })
})
