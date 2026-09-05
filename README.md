# dsh-usage-meter

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that reports **per-session token usage and estimated DeepSeek API cost** for the current session, using a bundled snapshot of [DeepSeek pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/). Defaults to **人民币 (CNY)** estimates, with USD available via configuration. Prices are not fetched automatically at runtime; see the snapshot date and overrides below.

Run `/usage` in any session (Web GUI or CLI) and the plugin folds that session's durable event log — the exact provider-reported `usage` records — into a per-model breakdown of input (cache miss / cache hit), output, reasoning, and total tokens, then prices them using DeepSeek's official rates, applying **peak / off-peak** rates per request time.

```
📊 26,181,549 tokens · 138 次请求 · ¥2.2421
  会话 session-d83cd3bc-225e-4d5d-bff8-d5702717c704
  完成轮次 2 · 当前第 3 轮进行中
  时间范围 2026-08-28 16:00:01 UTC ~ 2026-08-28 16:46:57 UTC
  计费 DeepSeek 官方人民币价格 — https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ (2026-08-21 抓取) · 按请求时间区分高峰/空闲

🧮 deepseek-official / deepseek-v4-flash
  费率 ¥1.5/M 未命中 · ¥0.05/M 命中 · ¥4.5/M 输出
  输入(未命中)         151,398  ¥0.2271
  输入(命中)        25,869,824  ¥1.2935
  输出                 160,327  ¥0.7215
  推理(含于输出)        97,806
  合计              26,181,549
  请求 138 次（空闲 138 · 高峰 0） · 缓存命中率 99.4%
  费用 ¥2.2421

💰 总计 ¥2.2421
```

## Install

Requires Node.js `^22.19.0 || >=24.0.0`, matching `package.json`, and an existing DSH CLI/profile. This package is a plugin, not a standalone chat client.

For a local checkout, prepare the package first:

```sh
git clone https://github.com/Anchen0823/dsh-usage-meter.git
cd dsh-usage-meter
npm ci
npm run build
cd ..
```

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
- **Rates.** Official per-1M-token prices, fetched `2026-08-21` (off-peak; peak is 2×):

  | Model | 缓存未命中 (miss) | 缓存命中 (hit) | 输出 (output) |
  |---|---|---|---|
  | deepseek-v4-flash | ¥1.5 · $0.22 | ¥0.05 · $0.007 | ¥4.5 · $0.66 |
  | deepseek-v4-flash-vision-exp | ¥1.5 · $0.22 | ¥0.05 · $0.007 | ¥4.5 · $0.66 |
  | deepseek-v4-pro | ¥4.5 · $0.66 | ¥0.15 · $0.022 | ¥13.5 · $1.98 |

  Archived V3 ids (`deepseek-chat`, `deepseek-reasoner`) are kept for older deployments in both currencies. CNY is the default (`currency: cny`); set `currency: usd` for the USD table.
- **Peak / off-peak.** DeepSeek-V4 bills peak hours at **2× off-peak**: 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri (equivalently 09:00–12:00 and 14:00–18:00 北京时间). Each request is priced at its own event time, so the mix is exact. Turn this off with `peakPricing: false` to price everything off-peak.
- **Unknown models.** Routes without a known price (or without provider/model attribution) still report tokens; their cost shows `—` and the total flags the number of unpriced routes.
- **Overrides.** Prices change — override any model's buckets under `priceOverrides` (in the selected currency) without touching the code.

> Prices are informative estimates computed from provider-reported usage with the official tables; DeepSeek's own balance statement remains authoritative.

## Configuration

Configure via the bundle row in your `cordis.patch.yml` (or `dsh.config`):

```yaml
- id: usage-meter
  name: dsh-usage-meter
  config:
    currency: cny
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
| `currency` | `cny` \| `usd` | `cny` | Billing currency; selects the official price table and the `¥`/`$` symbol. |
| `peakPricing` | boolean | `true` | Apply peak (2×) rates to requests in peak hours; `false` prices everything off-peak. |
| `priceOverrides` | record | `{}` | Per-model per-1M overrides (in the selected currency), merged over the official table. A model with no official price must override every bucket it should be billed for. |

## Development

```sh
npm ci             # Node ^22.19.0 || >=24.0.0; install from lockfile
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsdown -> lib/index.js
```

The build is a plain ESM transpile (unbundled `@deepseek-ai/*`, `schemastery`) with no type-checking or declaration emit, so it also runs as the `prepare` hook for git-based installs.

`scripts/report-session.mjs` is a diagnostic: it decodes a persisted `session.jsonl.zstd` log and runs the `/usage` fold over the real events without touching the running deployment.

### Source map

| Path | Purpose |
| --- | --- |
| [src/index.ts](src/index.ts) | Plugin registration and `/usage` command |
| [src/usage.ts](src/usage.ts) | Fold session events into usage totals |
| [src/pricing.ts](src/pricing.ts) | Bundled price tables and cost calculation |
| [src/report.ts](src/report.ts) | Format the usage report |
| [tests](tests/) | Usage, pricing, and report tests |
| [cordis.patch.yml](cordis.patch.yml) | DSH bundle configuration |

## Known limitations

- **Command-only surface.** Usage is shown on demand via `/usage`. Automatic per-turn display in the Web Client chat (a business conversation node) is future work; `session/event` listeners can already observe the same data the command folds.
- **Provider-reported usage only.** If an adapter reports no usage (or a request failed before reporting), those tokens cannot be billed and are not estimated.
- **Prices are a snapshot.** The tables were fetched on `2026-08-21`; re-verify against the [official docs](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) and use `priceOverrides` when they drift.
- **CNY and USD are separate official tables.** The CNY table is DeepSeek's published 人民币 pricing, not a USD conversion; the two may drift independently.

## License

[MIT](LICENSE)
