/**
 * One-off diagnostic: decode the current session's persisted zstd JSONL log
 * and run the dsh-usage-meter fold over the real events, without touching
 * the running deployment.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { apply } from '../lib/index.js'

const logPath = process.argv[2]
if (!logPath) {
  console.error('usage: node report-session.mjs <session.jsonl.zstd>')
  process.exit(1)
}

const buffer = readFileSync(logPath)

// Locate complete zstd frames: each starts with the 4-byte magic.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
let pos = 0
let frameStart = -1
while (pos < buffer.length) {
  if (buffer.subarray(pos, pos + 4).equals(MAGIC)) {
    if (frameStart >= 0) frames.push([frameStart, pos])
    frameStart = pos
  }
  pos += 1
}
if (frameStart >= 0) frames.push([frameStart, buffer.length])
console.error(`[decode] ${frames.length} zstd frame(s), ${buffer.length} compressed bytes`)

// Decompress each complete frame in order.
const plaintext = []
for (const [start, end] of frames) {
  plaintext.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
}
const text = plaintext.join('')

const lines = text.split('\n').filter(line => line.length > 0)
console.error(`[decode] ${lines.length} line(s)`)
const events = []
let header
for (const line of lines) {
  const parsed = JSON.parse(line)
  if (parsed.type === 'session') header = parsed
  else events.push(parsed)
}
console.error(`[decode] header id=${header?.id ?? '?'} · ${events.length} event(s)`)

// Drive the plugin exactly as the /usage command would.
let captured
const ctx = {
  effect(fn) { const r = fn(); if (r && typeof r.next === 'function') r.next(); return () => {} },
  commands: { register(def) { captured = def; return () => {} } },
}
apply(ctx, {})
const result = captured.handler({
  agent: { session: { id: header?.id ?? 'unknown', events } },
})
console.log(result.text)
