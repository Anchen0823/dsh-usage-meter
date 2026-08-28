/**
 * Session token-usage fold.
 *
 * Walks one session's durable event log and accumulates exact
 * provider-reported token usage, grouped by model route, mirroring the
 * replacement semantics of the harness's own token-usage projection: a usage
 * chunk and the final `assistant/message` usage of the same attempt replace
 * each other (never double counted), while a retried attempt adds anew.
 *
 * Cost is computed per sample at the sample's own event time, so DeepSeek
 * peak/off-peak rates apply per request rather than to the aggregate.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isPeakHour, type PriceResolver } from './pricing.ts'

/** Disjoint token buckets summed across one or more attempts. */
export interface UsageBucket {
  /** Uncached prompt input. */
  inputTokens: number
  /** Cached prompt input (cache hit). */
  cacheReadTokens: number
  /** Cache-write input, when the adapter reports it (billed at the miss rate). */
  cacheWriteTokens: number
  outputTokens: number
  /** Output subset spent on reasoning, when reported. */
  reasoningTokens: number
  /** Number of billed attempts that reported usage. */
  requests: number
}

/** One provider/model route's aggregated usage and cost. */
export interface RouteUsage {
  /** Empty when the route could not be attributed. */
  provider: string
  /** Empty when the route could not be attributed. */
  model: string
  bucket: UsageBucket
  /**
   * Summed USD cost of the route's priced samples; undefined when no price
   * is known for the model.
   */
  costUsd: number | undefined
  /** Attempts that fell in a DeepSeek peak window. */
  peakRequests: number
  /** Attempts that fell outside a DeepSeek peak window. */
  offPeakRequests: number
}

/** Complete usage and cost picture of one session log. */
export interface UsageSummary {
  /** Session id, when the caller knows it; '' otherwise. */
  readonly sessionId: string
  /** All-route totals. */
  readonly totals: UsageBucket
  /** Per-route aggregates in first-seen order. */
  readonly routes: readonly RouteUsage[]
  /** Sum of every priced route's cost; undefined when no route was priced. */
  readonly totalCostUsd: number | undefined
  /** Routes whose model has no known price (tokens still counted). */
  readonly unpricedRoutes: number
  /** `turn/end` events observed. */
  readonly completedTurns: number
  /** The currently open turn number, when a turn/start has no matching turn/end yet. */
  readonly openTurn: number | undefined
  /** Time of the first event in the log. */
  readonly firstEventTime: number | undefined
  /** Time of the last event in the log. */
  readonly lastEventTime: number | undefined
  /** Usage samples dropped because their counts were not valid safe integers. */
  readonly skippedSamples: number
  /** Usage samples without a provider/model attribution (chunk-only, no route context). */
  readonly unknownRouteSamples: number
}

const EMPTY_BUCKET: UsageBucket = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  requests: 0,
}

interface SampleBucket extends Omit<UsageBucket, 'requests'> {}

interface Attempt {
  readonly turn: number
  readonly step: number
  readonly buckets: SampleBucket
  readonly costUsd: number | undefined
  readonly routeKey: string
  readonly peak: boolean
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Convert one provider usage sample into a validated disjoint bucket.
 * @returns the bucket, or undefined when the sample is not usable
 *   (non-count fields, or reasoning exceeding output).
 */
export function bucketOf(usage: TokenUsage): SampleBucket | undefined {
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens)) return undefined
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const reasoningTokens = usage.reasoningTokens ?? 0
  if (!isCount(cacheReadTokens) || !isCount(cacheWriteTokens) || !isCount(reasoningTokens)) return undefined
  if (reasoningTokens > usage.outputTokens) return undefined
  return { inputTokens: usage.inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens: usage.outputTokens, reasoningTokens }
}

/**
 * USD cost of one sample under the resolver. Cache-write input is billed at
 * the cache-miss rate (DeepSeek reports no separate cache-write charge).
 * @returns undefined when the model has no known price.
 */
export function sampleCost(buckets: SampleBucket, model: string, timeMs: number, resolver: PriceResolver): number | undefined {
  const price = resolver(model, timeMs)
  if (price === undefined) return undefined
  return (
    ((buckets.inputTokens + buckets.cacheWriteTokens) / 1_000_000) * price.inputCacheMiss
    + (buckets.cacheReadTokens / 1_000_000) * price.inputCacheHit
    + (buckets.outputTokens / 1_000_000) * price.output
  )
}

const addBucket = (target: UsageBucket, source: SampleBucket, countRequest: boolean): void => {
  target.inputTokens += source.inputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.outputTokens += source.outputTokens
  target.reasoningTokens += source.reasoningTokens
  if (countRequest) target.requests += 1
}

const subtractBucket = (target: UsageBucket, source: SampleBucket, countRequest: boolean): void => {
  target.inputTokens -= source.inputTokens
  target.cacheReadTokens -= source.cacheReadTokens
  target.cacheWriteTokens -= source.cacheWriteTokens
  target.outputTokens -= source.outputTokens
  target.reasoningTokens -= source.reasoningTokens
  if (countRequest) target.requests -= 1
}

interface FoldState {
  readonly totals: UsageBucket
  readonly routes: Map<string, RouteUsage>
  readonly routeOrder: string[]
  readonly resolver: PriceResolver
  lastAttempt: Attempt | undefined
  latestContext: { readonly provider: string; readonly model: string } | undefined
  completedTurns: number
  openTurn: number | undefined
  skippedSamples: number
  unknownRouteSamples: number
  totalCostUsd: number | undefined
}

/**
 * `llm/retry-started` is a plugin-merged session event (dsh-llm-retry) that
 * the published `@deepseek-ai/dsh-session` types do not declare. Treat it as
 * an unknown event at the type level while still observing it at runtime.
 */
function isRetryStarted(event: SessionEvent): boolean {
  return (event as { type: string }).type === 'llm/retry-started'
}

/**
 * Fold one session's durable event log into a usage and cost summary.
 * Pure and replay-safe: the same events always produce the same summary, so
 * resumed sessions (whose seed history is part of `events`) are accounted
 * correctly without any plugin-held state.
 */
export function deriveSessionUsage(events: readonly SessionEvent[], resolver: PriceResolver): UsageSummary {
  const state: FoldState = {
    totals: { ...EMPTY_BUCKET },
    routes: new Map(),
    routeOrder: [],
    resolver,
    lastAttempt: undefined,
    latestContext: undefined,
    completedTurns: 0,
    openTurn: undefined,
    skippedSamples: 0,
    unknownRouteSamples: 0,
    totalCostUsd: undefined,
  }

  for (const event of events) {
    if (isRetryStarted(event)) {
      const data = (event as { type: 'llm/retry-started'; data: { turn: number; step: number } }).data
      if (state.lastAttempt !== undefined
        && state.lastAttempt.turn === data.turn
        && state.lastAttempt.step === data.step) {
        state.lastAttempt = undefined
      }
      continue
    }
    switch (event.type) {
      case 'turn/start':
        state.openTurn = event.data.turn
        break
      case 'turn/end':
        state.completedTurns += 1
        state.openTurn = undefined
        break
      case 'request/context':
        state.latestContext = { provider: event.data.provider, model: event.data.model }
        break
      case 'assistant/chunk':
        if (event.data.chunk.type === 'usage') {
          applySample(state, event.data.turn, event.data.step, event.data.chunk.usage, undefined, undefined, event.time)
        }
        break
      case 'assistant/message':
        if (event.data.usage !== undefined) {
          applySample(
            state,
            event.data.turn,
            event.data.step,
            event.data.usage,
            event.data.message.source.provider,
            event.data.message.source.model,
            event.time,
          )
        }
        break
      default:
        break
    }
  }

  const routes = state.routeOrder
    .map(key => state.routes.get(key))
    .filter((route): route is RouteUsage => route !== undefined && route.bucket.requests > 0)
  const unpricedRoutes = routes.filter(route => route.costUsd === undefined).length

  return {
    sessionId: '',
    totals: state.totals,
    routes,
    totalCostUsd: state.totalCostUsd,
    unpricedRoutes,
    completedTurns: state.completedTurns,
    openTurn: state.openTurn,
    firstEventTime: events.length > 0 ? events[0]!.time : undefined,
    lastEventTime: events.length > 0 ? events[events.length - 1]!.time : undefined,
    skippedSamples: state.skippedSamples,
    unknownRouteSamples: state.unknownRouteSamples,
  }
}

function routeOf(state: FoldState, provider: string, model: string): RouteUsage {
  const key = `${provider}\0${model}`
  const existing = state.routes.get(key)
  if (existing !== undefined) return existing
  const created: RouteUsage = {
    provider,
    model,
    bucket: { ...EMPTY_BUCKET },
    costUsd: undefined,
    peakRequests: 0,
    offPeakRequests: 0,
  }
  state.routes.set(key, created)
  state.routeOrder.push(key)
  return created
}

function addSampleToRoute(route: RouteUsage, buckets: SampleBucket, costUsd: number | undefined, peak: boolean): void {
  addBucket(route.bucket, buckets, true)
  if (costUsd !== undefined) route.costUsd = (route.costUsd ?? 0) + costUsd
  if (peak) route.peakRequests += 1
  else route.offPeakRequests += 1
}

function subtractSampleFromRoute(route: RouteUsage, buckets: SampleBucket, costUsd: number | undefined, peak: boolean): void {
  subtractBucket(route.bucket, buckets, true)
  if (costUsd !== undefined) route.costUsd = (route.costUsd ?? 0) - costUsd
  if (peak) route.peakRequests -= 1
  else route.offPeakRequests -= 1
}

function applySample(
  state: FoldState,
  turn: number,
  step: number,
  usage: TokenUsage,
  provider: string | undefined,
  model: string | undefined,
  time: number,
): void {
  const buckets = bucketOf(usage)
  if (buckets === undefined) {
    state.skippedSamples += 1
    return
  }
  const routeProvider = provider ?? state.latestContext?.provider ?? ''
  const routeModel = model ?? state.latestContext?.model ?? ''
  if (routeProvider.length === 0 || routeModel.length === 0) state.unknownRouteSamples += 1
  const routeKey = `${routeProvider}\0${routeModel}`
  const peak = isPeakHour(time)
  const cost = sampleCost(buckets, routeModel, time, state.resolver)

  const previous = state.lastAttempt
  if (previous !== undefined && previous.turn === turn && previous.step === step) {
    const previousRoute = state.routes.get(previous.routeKey)
    if (previousRoute !== undefined) {
      subtractSampleFromRoute(previousRoute, previous.buckets, previous.costUsd, previous.peak)
      subtractBucket(state.totals, previous.buckets, true)
      if (previous.costUsd !== undefined) {
        state.totalCostUsd = (state.totalCostUsd ?? 0) - previous.costUsd
      }
    }
    state.lastAttempt = undefined
  }

  const route = routeOf(state, routeProvider, routeModel)
  addSampleToRoute(route, buckets, cost, peak)
  addBucket(state.totals, buckets, true)
  if (cost !== undefined) state.totalCostUsd = (state.totalCostUsd ?? 0) + cost
  state.lastAttempt = { turn, step, buckets, costUsd: cost, routeKey, peak }
}
