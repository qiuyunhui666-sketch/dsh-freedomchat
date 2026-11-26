/**
 * Durable bits of dsh-freedomchat:
 *  - which side thread belongs to which main session (so a restart resumes it)
 *  - the switches last chosen for that thread
 *  - where a child session's artifact lives, and how to delete it
 *
 * The registry is a single JSON file. Writes are serialized and atomic
 * (tmp + rename) so a crash never leaves half a file behind.
 */
import { mkdir, readFile, rename, rm, stat as statOf, writeFile } from 'node:fs/promises'

export const DSH_HOME = 'C:/Users/MIS/.dsh'
const STATE_DIR = process.env.FREEDOMCHAT_STATE_DIR ?? `${DSH_HOME}/freedomchat`
const STATE_FILE = `${STATE_DIR}/threads.json`
const SESSIONS_ROOT = process.env.FREEDOMCHAT_SESSIONS_ROOT ?? `${DSH_HOME}/sessions`

const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @type {{version:number, threads:Record<string, any>}|null} */
let cache = null
let writing = Promise.resolve()

const emptyRegistry = () => ({ version: 1, threads: {}, created: {} })

export async function loadRegistry() {
  if (cache !== null) return cache
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.threads && typeof parsed.threads === 'object') {
      cache = {
        version: 1,
        threads: { ...parsed.threads },
        ...(parsed.created && typeof parsed.created === 'object' ? { created: { ...parsed.created } } : {}),
      }
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
 * DSH names a session's project folder after its cwd. Verified against every
 * project segment this machine has produced, the rule is:
 *
 *   - wrap the result in `--` … `--`
 *   - `:` `\` `/` each become `-`, then runs of `-` collapse into one
 *   - a non-ASCII code point becomes `~` + uppercase hex padded to 4 digits
 *   - any other non `[A-Za-z0-9._-]` character is escaped the same way
 *
 * So `D:\DSH\work` → `--D-DSH-work--` (not `--D--DSH-work--`), `D:\量` →
 * `--D-~91CF--`, and `…Growth cycylic…` → `…Growth~0020cycylic…`.
 *
 * Getting this wrong is silent: `rm(path, {force:true})` succeeds on a path
 * that does not exist, so every "delete the child session" path would look
 * like it worked while leaving the transcript on disk.
 */
export function encodeProjectSegment(cwd) {
  const raw = String(cwd)
  if (raw === '' || raw.includes('..')) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(raw)) return undefined
  let body = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0)
    if (code === undefined) return undefined
    if (ch === ':' || ch === '\\' || ch === '/') {
      body += '-'
    } else if (/[A-Za-z0-9._-]/.test(ch)) {
      body += ch
    } else {
      body += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }
  return `--${body.replace(/-+/g, '-')}--`
}

export function sessionDirOf(sessionId, cwd) {
  if (!SESSION_ID_RE.test(String(sessionId))) return undefined
  const segment = encodeProjectSegment(cwd ?? '')
  if (segment === undefined) return undefined
  if (segment.includes('/') || segment.includes('\\')) return undefined
  return `${SESSIONS_ROOT}/${segment}/${sessionId}`
}

/**
 * Delete a child session's folder. Returns `true` only when something was
 * actually removed, so callers can tell a real deletion from a path that never
 * existed (`rm` with `force` reports success either way).
 */
export async function deleteSessionArtifact(sessionId, cwd) {
  const dir = sessionDirOf(sessionId, cwd)
  if (dir === undefined) return false
  return deleteDirStrict(dir)
}

async function deleteDirStrict(dir) {
  try {
    await statOf(dir)
  } catch {
    return false
  }
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
/**
 * Every thread id this plugin ever minted, even after the mapping is dropped.
 * `清空` deletes the transcript and the mapping together, so without this a
 * transcript that survived a failed delete has nothing left to identify it.
 */
export async function noteCreated(threadId, parentSessionId, cwd) {
  const registry = await loadRegistry()
  registry.created = { ...(registry.created ?? {}) }
  registry.created[threadId] = { parentSessionId, cwd, at: Date.now() }
  // Keep the ledger bounded: it only exists to attribute transcripts whose
  // delete failed, so a few hundred recent ids is plenty.
  const ids = Object.keys(registry.created)
  if (ids.length > 300) {
    ids
      .sort((left, right) => (registry.created[left].at ?? 0) - (registry.created[right].at ?? 0))
      .slice(0, ids.length - 300)
      .forEach((id) => delete registry.created[id])
  }
  await saveRegistry()
}

export async function createdThreads() {
  const registry = await loadRegistry()
  return Object.entries(registry.created ?? {})
}
