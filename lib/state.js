/**
 * Durable bits of dsh-freedomchat:
 *  - which side thread belongs to which main session (so a restart resumes it)
 *  - the switches last chosen for that thread
 *  - where a child session's artifact lives, and how to delete it
 *
 * The registry is a single JSON file. Writes are serialized and atomic
 * (tmp + rename) so a crash never leaves half a file behind.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'

export const DSH_HOME = 'C:/Users/MIS/.dsh'
const STATE_DIR = process.env.FREEDOMCHAT_STATE_DIR ?? `${DSH_HOME}/freedomchat`
const STATE_FILE = `${STATE_DIR}/threads.json`
const SESSIONS_ROOT = process.env.FREEDOMCHAT_SESSIONS_ROOT ?? `${DSH_HOME}/sessions`

const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @type {{version:number, threads:Record<string, any>}|null} */
let cache = null
let writing = Promise.resolve()

const emptyRegistry = () => ({ version: 1, threads: {} })

export async function loadRegistry() {
  if (cache !== null) return cache
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.threads && typeof parsed.threads === 'object') {
      cache = { version: 1, threads: { ...parsed.threads } }
    } else {
      cache = emptyRegistry()
    }
  } catch {
    cache = emptyRegistry()
  }
  return cache
}

export async function saveRegistry() {
  const data = cache ?? emptyRegistry()
  const body = JSON.stringify(data, null, 2)
  writing = writing
    .then(async () => {
      await mkdir(STATE_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, STATE_FILE)
    })
    .catch(() => {})
  await writing
}

export async function entryOf(parentSessionId) {
  const registry = await loadRegistry()
  return registry.threads[parentSessionId]
}

export async function putEntry(parentSessionId, patch) {
  const registry = await loadRegistry()
  const next = { ...(registry.threads[parentSessionId] ?? {}), ...patch, updatedAt: Date.now() }
  registry.threads[parentSessionId] = next
  await saveRegistry()
  return next
}

export async function dropEntry(parentSessionId) {
  const registry = await loadRegistry()
  if (registry.threads[parentSessionId] === undefined) return
  delete registry.threads[parentSessionId]
  await saveRegistry()
}

export async function entries() {
  const registry = await loadRegistry()
  return Object.entries(registry.threads)
}

/**
 * DSH names a session's project folder after its cwd: `D:\DSH\work` becomes
 * `--D-DSH-work--` (colons and separators turn into dashes, non-ASCII bytes
 * escape as `~HEX`). We only ever produce ASCII paths here, but refuse
 * anything that could escape the sessions root.
 */
export function encodeProjectSegment(cwd) {
  const raw = String(cwd)
  if (raw === '' || raw.includes('..')) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(raw)) return undefined
  let out = '--'
  for (const ch of raw) {
    const code = ch.codePointAt(0)
    if (code !== undefined && code > 0x7f) {
      out += `~${code.toString(16).toUpperCase()}`
    } else if (ch === ':' || ch === '\\' || ch === '/') {
      out += '-'
    } else {
      out += ch
    }
  }
  return `${out}--`
}

export function sessionDirOf(sessionId, cwd) {
  if (!SESSION_ID_RE.test(String(sessionId))) return undefined
  const segment = encodeProjectSegment(cwd ?? '')
  if (segment === undefined) return undefined
  if (segment.includes('/') || segment.includes('\\')) return undefined
  return `${SESSIONS_ROOT}/${segment}/${sessionId}`
}

export async function deleteSessionArtifact(sessionId, cwd) {
  const dir = sessionDirOf(sessionId, cwd)
  if (dir === undefined) return false
  await rm(dir, { recursive: true, force: true })
  return true
}

/**
 * The host keeps the archive set in the workspace registry. Returns `null`
 * when the registry cannot answer (then the caller must not assume anything).
 */
export function archivedSessionIds(ctx) {
  try {
    const registry = ctx.get?.('workspaceRegistry')
    if (registry && typeof registry.requireState === 'function') {
      const state = registry.requireState()
      const ids = state?.archivedSessionIds
      if (Array.isArray(ids)) return new Set(ids)
    }
  } catch {
    /* registry not ready: unknown */
  }
  return null
}