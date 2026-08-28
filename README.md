# dsh-usage-meter

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that reports **per-session token usage and DeepSeek API cost** for the current session, billed with the [official DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).

Run `/usage` in any session (Web GUI or CLI) and the plugin folds that session's durable event log — the exact provider-reported `usage` records — into a per-model breakdown of input (cache miss / cache hit), output, reasoning, and total tokens, then prices them in USD using DeepSeek's official rates, applying **peak / off-peak** rates per request time.

```
Token usage and API cost for session session-123
  completed turns: 5 · current turn 6 in progress
  billed requests: 12 · first event: 2026-08-21 09:02:11 UTC · last event: 2026-08-21 10:14:37 UTC
  pricing: DeepSeek official pricing — https://api-docs.deepseek.com/quick_start/pricing/ (fetched 2026-08-21) · peak/off-peak applied per request time

Per model:
  deepseek / deepseek-v4-flash
    input (cache miss): 123,456
    input (cache hit):  45,678
    output:              9,012
    reasoning:           1,234
    total tokens:      178,146
    requests: 10 (7 off-peak, 3 peak)
    cost: $0.0842

Total: 178,146 tokens · cost $0.0842
```

## Install

The plugin ships as a [DSH bundle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md). With the `dsh` CLI installed, from any profile:

```sh
# from a local checkout
dsh plugin --profile <name> add ./dsh-usage-meter   # requires `npm run build` first

# straight from GitHub (sources; pnpm runs the `prepare` build on install)
dsh plugin --profile <name> add github:Anchen0823/dsh-usage-meter
```

The first git-based install may ask you to allow the package's `prepare` build; copy the package key pnpm prints into the profile's `pnpm-workspace.yaml` `allowBuilds` and re-run. Pin a commit (`github:Anchen0823/dsh-usage-meter#<sha>`) for reproducible installs.

Restart (or hot-reload) the session and type `/usage`.

## How billing works

- **Usage source.** The fold reads `assistant/chunk { type: 'usage' }` and `assistant/message.usage` records from the session log — the same exact, provider-reported buckets the harness itself tracks. Nothing is estimated heuristically, and a usage sample replaced by the final message of the same attempt is never double counted (retried attempts add once each).
- **Buckets.** DeepSeek reports uncached input, cached input (cache hit), and output; reasoning is the output subset. Billed input = uncached input at the cache-miss rate + cached input at the cache-hit rate (cache-write input, when another adapter reports it, is billed at the miss rate — DeepSeek reports no separate cache-write charge).
- **Rates.** USD per 1M tokens, from the official docs (fetched `2026-08-21`): `deepseek-v4-flash` — miss $0.22 / hit $0.007 / output $0.66; `deepseek-v4-pro` — miss $0.66 / hit $0.022 / output $1.98; `deepseek-v4-flash-vision-exp` — same as flash. Archived V3 ids (`deepseek-chat`, `deepseek-reasoner`) are kept for older deployments.
- **Peak / off-peak.** DeepSeek-V4 bills peak hours (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri) at **2× off-peak**. Each request is priced at its own event time, so the mix is exact. Turn this off with `peakPricing: false` to price everything off-peak.
- **Unknown models.** Routes without a known price (or without provider/model attribution) still report tokens; their cost shows `—` and the total flags the number of unpriced routes.
- **Overrides.** Prices change — override any model's buckets under `priceOverrides` (see below) without touching the code.

> Prices are informative estimates computed from provider-reported usage with the official table; DeepSeek's own balance statement remains authoritative.

## Configuration

Configure via the bundle row in your `cordis.patch.yml` (or `dsh.config`):

```yaml
- id: usage-meter
  name: dsh-usage-meter
  config:
    peakPricing: true
    priceOverrides:
      deepseek-v4-flash:
        output: 0.5
      my-custom-model:
        inputCacheMiss: 1.0
        inputCacheHit: 0.1
        output: 2.0
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `peakPricing` | boolean | `true` | Apply peak (2×) rates to requests in peak hours; `false` prices everything off-peak. |
| `priceOverrides` | record | `{}` | Per-model USD per-1M overrides, merged over the official table. A model with no official price must override every bucket it should be billed for. |

## Development

```sh
npm install        # node >= 22; installs dev toolchain
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsdown -> lib/index.js
```

The build is a plain ESM transpile (`external: @deepseek-ai/*, schemastery`) with no type-checking or declaration emit, so it also runs as the `prepare` hook for git-based installs.

## Known limitations

- **Command-only surface.** Usage is shown on demand via `/usage`. Automatic per-turn display in the Web Client chat (a business conversation node) is future work; `session/event` listeners can already observe the same data the command folds.
- **Provider-reported usage only.** If an adapter reports no usage (or a request failed before reporting), those tokens cannot be billed and are not estimated.
- **Prices are a snapshot.** The table was fetched on `2026-08-21`; re-verify against the [official docs](https://api-docs.deepseek.com/quick_start/pricing/) and use `priceOverrides` when they drift.
- **USD only.** DeepSeek's platform bills USD; no currency conversion is offered.

## License

[MIT](LICENSE)
