/**
 * Delete side-thread transcripts this plugin left behind: subagent sessions
 * whose log carries the Freedom Chat prompt marker but that the registry no
 * longer points at.
 *
 * Older builds tracked only one thread per main session, so every restart or
 * 清空 could strand a transcript. Those stranded transcripts surface in DSH's
 * "delete this session" dialog as extra 子智能体会话.
 *
 * Only sessions with `origin:'subagent'` and a `parentSession` header are
 * considered — a main conversation may legitimately contain the words
 * "侧边自由对话" without being one of our threads.
 *
 * Dry run:    node scripts/cleanup-orphans.mjs
 * Delete:     node scripts/cleanup-orphans.mjs --delete
 * One parent: node scripts/cleanup-orphans.mjs --parent session-xxxx [--delete]
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createdThreads, DSH_HOME, entries } from '../lib/state.js'

const DRY = !process.argv.includes('--delete')
const parentFlagIndex = process.argv.indexOf('--parent')
const onlyParent = parentFlagIndex === -1 ? undefined : process.argv[parentFlagIndex + 1]

const SESSIONS = process.env.FREEDOMCHAT_SESSIONS_ROOT ?? `${DSH_HOME}/sessions`
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// Only this plugin's own system prompt proves authorship: a beta side chat or
// any subagent seeded with the main history also quotes the words above.
const MARKER = /你现在位于 DSH 的「侧边自由对话」面板中|与主对话隔离的独立线程/
// Evidence that a model actually answered inside this transcript. A thread
// without one never really started, so it cannot be a beta side chat or a
// subagent worth keeping either.
const ANSWERED = /"type":"assistant\/message"|"type":"message\/assistant"|"type":"reasoning"/

function frames(buf) {
  const offsets = []
  let at = buf.indexOf(MAGIC, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(MAGIC, at + 4)
  }
  return offsets.map((offset, index) => buf.subarray(offset, offsets[index + 1] ?? buf.length))
}

/** The header lives in the first frame; decoding it alone keeps JSON intact. */
function readHeader(buf) {
  try {
    const first = zstdDecompressSync(frames(buf)[0]).toString('utf8')
    const parsed = JSON.parse(first.split('\n', 1)[0])
    return parsed.header ?? parsed
  } catch {
    return undefined
  }
}

function decodeAll(buf) {
  const chunks = []
  for (const frame of frames(buf)) {
    try {
      chunks.push(zstdDecompressSync(frame))
    } catch {
      /* a truncated tail frame is fine */
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

// A thread the registry still points at is in use; anything only in `history`
// is superseded. Both are ours by construction, so they count even when the
// transcript no longer carries the system prompt (e.g. it was never answered).
// `created` survives a 清空 that dropped the mapping, so a transcript whose
// delete silently failed is still attributable.
const live = new Set()
const known = new Set()
const parents = new Set()
for (const [parent, entry] of await entries()) {
  parents.add(parent)
  if (typeof entry?.threadId === 'string') {
    live.add(entry.threadId)
    known.add(entry.threadId)
  }
  for (const id of entry?.history ?? []) known.add(id)
}
for (const [id, meta] of await createdThreads()) {
  known.add(id)
  if (typeof meta?.parentSessionId === 'string') parents.add(meta.parentSessionId)
}

const found = []
for (const segment of readdirSync(SESSIONS)) {
  const dir = join(SESSIONS, segment)
  let names
  try {
    if (!statSync(dir).isDirectory()) continue
    names = readdirSync(dir)
  } catch {
    continue
  }
  for (const name of names) {
    if (!name.startsWith('session-')) continue
    const file = join(dir, name, 'session.v4.jsonl.zstd')
    let buf
    try {
      buf = readFileSync(file)
    } catch {
      continue
    }
    const header = readHeader(buf)
    if (header?.origin !== 'subagent' || !header?.parentSession) continue
    // A thread that was created and never answered is ours by construction: it
    // belongs to a parent this plugin tracks, and deleting it loses nothing.
    // `empty` (a bare header) is the cheapest form, but a thread whose only
    // turns died before any model ran (e.g. "has no provider/model") has no
    // system prompt and no assistant row either — it is just as certainly ours.
    const empty = buf.length < 600
    const text = decodeAll(buf)
    const mine =
      known.has(name) ||
      MARKER.test(text) ||
      (parents.has(header.parentSession) && (empty || !ANSWERED.test(text)))
    if (!mine) continue
    found.push({
      segment,
      sessionId: name,
      parent: header.parentSession,
      createdAt: header.createdAt,
      depth: header.delegationDepth,
      bytes: buf.length,
      live: live.has(name),
    })
  }
}

const targets = found.filter(
  (item) => (onlyParent === undefined || item.parent === onlyParent) && !item.live,
)

console.log(`本插件的侧边会话记录共 ${found.length} 条（登记在册 ${found.length - targets.length} 条）。`)
for (const item of found) {
  const when = item.createdAt ? new Date(item.createdAt).toISOString() : '?'
  console.log(
    `${item.live ? 'KEEP  ' : 'ORPHAN'} ${item.sessionId}  parent=${item.parent}  depth=${item.depth ?? '?'}  created=${when}  ${Math.round(item.bytes / 1024)}KB`,
  )
}

if (targets.length === 0) {
  console.log('没有需要清理的孤儿。')
  process.exit(0)
}

if (DRY) {
  console.log(`\n[dry run] 加 --delete 会删除上面 ${targets.length} 条 ORPHAN。`)
  process.exit(0)
}

for (const item of targets) {
  rmSync(join(SESSIONS, item.segment, item.sessionId), { recursive: true, force: true })
  console.log(`deleted ${item.sessionId}`)
}
console.log(`\n已删除 ${targets.length} 条孤儿会话。`)