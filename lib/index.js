/**
 * dsh-freedomchat — host half.
 *
 * One side thread per main session: a child session created with
 * `origin: 'subagent'` and a BLANK log (never seeded with the parent's), plus
 * an HTTP bridge the zero-build client half calls.
 *
 * Wire: POST /freedomchat/api/<method>, JSON body, `{ok:true,value}` or
 * `{ok:false,error:{code,message}}`. The dispatch table is data, so adding a
 * method needs no route change.
 */
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  archivedSessionIds,
  deleteSessionArtifact,
  dropEntry,
  entries,
  entryOf,
  putEntry,
} from './state.js'

export const name = 'dsh-freedomchat'
export const inject = ['webServer', 'connection', 'systemPrompt']

const BOOT_LOG =
  process.env.FREEDOMCHAT_BOOT_LOG ?? 'C:/Users/MIS/.dsh/freedomchat-boot.log'
const API_PREFIX = '/freedomchat/api'
const MAX_BODY_BYTES = 1 << 20
const CREATE_TIMEOUT_MS = 30_000
/** How often the archive sweep may look at the workspace registry. */
const SWEEP_MS = Number(process.env.FREEDOMCHAT_SWEEP_MS ?? 1_000) || 0

/**
 * `createUserMessage` only stamps `role`/`id` onto the input, so a plain
 * object keeps the bridge working when the host package cannot be imported
 * (plain-node smoke tests, future packaging changes).
 */
let createUserMessage
try {
  const hostLlm = await import('@deepseek-ai/dsh-llm')
  createUserMessage = hostLlm.createUserMessage
} catch {
  createUserMessage = undefined
}

function userMessage(content) {
  if (typeof createUserMessage === 'function') {
    return createUserMessage({ content, source: { kind: 'user' } })
  }
  return { id: `msg-${randomUUID()}`, role: 'user', content, source: { kind: 'user' } }
}

/* ────────────────────────────── errors ────────────────────────────── */

class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

const fail = (code, message, status) => new ApiError(code, message, status)

/* ────────────────────────────── wire ────────────────────────────── */

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw fail('too-large', 'request body too large', 413)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw fail('bad-request', 'request body is not valid JSON')
  }
}

function writeJson(res, status, body) {
  if (res.headersSent === true) {
    res.destroy?.()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const writeOk = (res, value) => writeJson(res, 200, { ok: true, value })

function writeError(res, error) {
  if (error instanceof ApiError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/* ────────────────────────────── tools ────────────────────────────── */

const RUN_CODE = 'run_code'

/**
 * Web-facing tools the panel may lend to the side thread. Everything else stays
 * hidden; the names are also the only ones the pre-execute gate will let through
 * while the panel's web switch is on.
 */
const WEB_TOOL_NAMES = Object.freeze(['web_search', 'web_fetch', 'research'])
const READ_SIDE_TOOL = 'read_freedom_chat'
const READ_MAIN_TOOL = 'read_main_conversation'
const APPROVAL_TIMEOUT_MS = 120_000
const TRANSCRIPT_LIMIT = 20
// The panel polls while it is on screen; that poll is the heartbeat. A closed
// tab, a crashed renderer or a stalled poll must not leave the main session
// able to read the side thread, so `open` alone is never trusted.
const OPEN_STALE_MS = 60_000

/** Panel switches, per thread. `sideRead` is a tri-state. */
const DEFAULT_SETTINGS = Object.freeze({ open: false, mainRead: false, sideRead: 'deny', web: false })
const SIDE_READ_MODES = Object.freeze(['allow', 'ask', 'deny'])

/**
 * Restriction lifts created for one agent at setup time, kept so the web switch
 * can drop them and re-restrict the same agent later.
 */
const liftsByAgent = new WeakMap()

/**
 * Hide every tool from the side thread.
 *
 * Two host facts shape this:
 *  - `restrict()` masks INHERITED (global) names only. A name registered on the
 *    agent's own layer — which is exactly what dsh-ops' `ops_bash` layer is —
 *    makes the WHOLE call throw, so a single scoped name would otherwise
 *    silently undo the entire restriction (observed: the side thread ran bash).
 *  - Tools can appear after `setup` (dsh-ops mounts its layer on `agent/created`),
 *    so a snapshot taken here may be incomplete.
 *
 * Hence: try the whole list once, fall back to one `restrict()` per name, and
 * report what stayed scoped. Execution is blocked independently by the global
 * `tools/pre-execute` gate below, which does not depend on visibility.
 */
function installZeroTools(agentCtx, agent) {
  try {
    const tools = agentCtx?.tools
    if (tools === undefined) return
    let names = []
    try {
      const schemas = tools.schemas?.(agent)
      if (Array.isArray(schemas)) names = schemas.map((schema) => schema?.name).filter((entry) => typeof entry === 'string')
    } catch {
      /* schemas is optional */
    }
    if (names.length === 0) {
      try {
        const view = tools.view?.(agent)
        if (view?.restrictableNames !== undefined) names = [...view.restrictableNames]
      } catch {
        /* the view hook is optional */
      }
    }
    if (names.length === 0) {
      try {
        names = tools.definitions(agent).map((definition) => definition.name)
      } catch {
        /* definitions is optional too */
      }
    }
    const deny = [...new Set(names)].filter((entry) => entry !== RUN_CODE)
    if (deny.length === 0) return
    const keep = (lift) => {
      if (typeof lift !== 'function') return
      const lifts = liftsByAgent.get(agent) ?? []
      lifts.push(lift)
      liftsByAgent.set(agent, lifts)
      if (typeof agentCtx.effect === 'function') agentCtx.effect(() => lift, 'dsh-freedomchat: zero tools')
    }
    try {
      keep(tools.restrict({ deny }))
      log(`zero-tools: hid ${deny.length} inherited tools`)
      return
    } catch {
      /* at least one name lives in the agent's own layer: mask the rest one by one */
    }
    let hidden = 0
    const scoped = []
    for (const name of deny) {
      try {
        keep(tools.restrict({ deny: [name] }))
        hidden += 1
      } catch {
        scoped.push(name)
      }
    }
    log(`zero-tools: hid ${hidden}, own-layer left ${scoped.length}${scoped.length > 0 ? ` (${scoped.slice(0, 10).join(',')})` : ''}`)
  } catch (error) {
    log(`zero-tools failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The side thread's standing instructions. Only our agents get this text. */
const SIDE_PROMPT_LINES = [
  '你现在位于 DSH 的「侧边自由对话」面板中，这是一个与主对话隔离的独立线程。',
  '- 你没有本地执行权限：不能读写文件、不能运行命令；除下面说明的联网工具外，调用工具会被宿主直接拒绝。',
  '- 你看不到主对话的历史，除非用户把内容贴进来，或下面说明的读取工具对你开放。',
  '- 你的工作就是对话：讨论、解释、起草、推演、答疑。',
  '- 如果用户要求你操作本地文件或运行命令，说明这里没有该权限，并建议他们在主对话里完成。',
  '- 用用户所用的语言回答。',
]

/**
 * Standing instructions plus whatever the panel switches currently grant. The
 * switches are read live, so the next turn sees the new text without rebuilding
 * the agent.
 */
function sidePromptFor(agent) {
  const thread = threads.get(agent?.session?.id)
  if (thread === undefined) return ''
  const lines = [...SIDE_PROMPT_LINES]
  if (thread.settings.sideRead === 'allow') {
    lines.push(`- 用户允许你读取主对话：工具 ${READ_MAIN_TOOL} 可用，返回主对话最近 ${TRANSCRIPT_LIMIT} 条正文。只在确实需要时调用。`)
  } else if (thread.settings.sideRead === 'ask') {
    lines.push(`- 工具 ${READ_MAIN_TOOL} 可用，但每次调用都要用户在面板上点「允许」，否则会被拒绝。需要主对话内容时先说明理由再调用。`)
  } else {
    lines.push('- 读取主对话的工具对你关闭，不要尝试调用。')
  }
  lines.push(thread.settings.web ? `- 联网工具已开启：${WEB_TOOL_NAMES.join('、')}。可以按需使用。` : '- 联网工具对你是关闭的。')
  return lines.join('\n')
}

/* ────────────────────────────── threads ────────────────────────────── */

/**
 * @typedef {object} Thread
 * @property {string} threadId
 * @property {string} parentSessionId
 * @property {object} handle      `agents.create` result (agent + dispose)
 * @property {number} version     bumped on every durable event or live chunk
 * @property {{text: string}} live in-flight assistant text
 */
/** Cold-resume a side thread whose agent is gone (host restart). */
async function resumeThread(ctx, parentSessionId, entry) {
  const agents = ctx.get('agents')
  if (typeof agents?.resume !== 'function') return undefined
  const threadId = String(entry?.threadId ?? '')
  if (!threadId.startsWith('session-')) return undefined
  const persistence = ctx.get('sessionPersistence')
  let header
  if (typeof persistence?.stat === 'function') {
    try {
      header = (await persistence.stat(threadId))?.header
    } catch {
      log(`thread ${threadId} artifact missing — dropping the mapping`)
      await dropEntry(parentSessionId)
      return undefined
    }
  }
  let handle
  try {
    handle = await agents.resume({ resumeSessionId: threadId, setup: installZeroTools })
  } catch (error) {
    log(`thread resume failed ${threadId}: ${error?.message ?? error}`)
    await dropEntry(parentSessionId)
    return undefined
  }
  const thread = {
    threadId,
    parentSessionId,
    ctx,
    handle,
    cwd: header?.cwd ?? entry.cwd,
    version: 0,
    live: { text: '', attempt: undefined, nextIndex: 0 },
    settings: { ...DEFAULT_SETTINGS, ...(entry.settings ?? {}), open: false },
    openPingAt: 0,
    approval: undefined,
    parentTool: undefined,
    sideTool: undefined,
  }
  const remembered = entry?.model
  if (
    remembered !== undefined &&
    typeof remembered.provider === 'string' &&
    typeof remembered.model === 'string'
  ) {
    thread.modelHint = { ...remembered }
    if (modelOf(handle.agent) === undefined) {
      try {
        await handle.agent.model?.select?.({
          provider: remembered.provider,
          model: remembered.model,
          ...(remembered.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: await brandedEffort(remembered.reasoningEffort) }),
        })
      } catch (error) {
        log(`model rebind failed ${threadId}: ${error?.message ?? error}`)
      }
    }
  }
  if (thread.modelHint === undefined) await bindModelHint(ctx, thread)
  threads.set(threadId, thread)
  parentIndex.set(parentSessionId, threadId)
  applySettings(thread)
  log(`thread resumed ${threadId} for ${parentSessionId}`)
  return thread
}

/**
 * Whether the main session still exists. `undefined`/missing → gone; any other
 * error is treated as "unknown, keep it" so a locked file never destroys data.
 */
async function parentSessionAlive(ctx, parentSessionId) {
  // Three independent "it still exists" signals. Retiring deletes files, so a
  // false negative is destructive: only say "gone" when every signal agrees.
  try {
    if (ctx.get('sessions')?.get?.(parentSessionId) !== undefined) return true
  } catch {
    /* service shape varies — fall through */
  }
  try {
    if (ctx.get('workspaceRegistry')?.headers?.has?.(parentSessionId) === true) return true
  } catch {
    /* same */
  }
  const persistence = ctx.get('sessionPersistence')
  if (typeof persistence?.stat !== 'function') return true
  try {
    const stat = await persistence.stat(parentSessionId)
    return stat !== undefined && stat !== null
  } catch (error) {
    const message = String(error?.message ?? error)
    if (error?.code === 'ENOENT' || /no such|not found|missing|unknown session/i.test(message)) return false
    return true
  }
}

/** Turn one thread's storage into a tombstone and drop its artifact. */
async function retireThread(ctx, parentSessionId, entry, reason = 'archived') {
  const live = threads.get(entry.threadId)
  if (live !== undefined) await disposeThread(live)
  let deleted = 0
  const doomed = new Set(
    [entry.threadId, ...(Array.isArray(entry.history) ? entry.history : [])].filter(
      (id) => typeof id === 'string' && id.startsWith('session-'),
    ),
  )
  for (const id of doomed) {
    try {
      if (await deleteSessionArtifact(id, entry.cwd)) deleted += 1
    } catch (error) {
      log(`artifact delete failed ${id}: ${error?.message ?? error}`)
    }
  }
  await putEntry(parentSessionId, { threadId: null, state: 'archived', archivedAt: Date.now(), history: [] })
  if (typeof entry.threadId === 'string' && entry.threadId !== '') {
    retired.set(entry.threadId, { parentSessionId, at: Date.now() })
  }
  log(`thread retired (main ${reason}) parent=${parentSessionId} artifactDeleted=${deleted}`)
}

let lastSweepAt = 0

/**
 * The main session being archived deletes its side thread — the user asked for
 * exactly that, and the child is not reachable from any list afterwards.
 */
async function sweepLifecycle(ctx) {
  if (Date.now() - lastSweepAt < SWEEP_MS) return
  lastSweepAt = Date.now()
  const archived = archivedSessionIds(ctx)
  if (archived === null) return
  for (const [parentSessionId, entry] of await entries()) {
    if (entry?.state === 'archived') continue
    if (archived.has(parentSessionId)) {
      await retireThread(ctx, parentSessionId, entry, 'archived')
      continue
    }
    if (!(await parentSessionAlive(ctx, parentSessionId))) {
      await retireThread(ctx, parentSessionId, entry, 'deleted')
    }
  }
}

const threads = new Map()
const parentIndex = new Map()
/** Threads killed by the archive/delete sweep, so late polls can be told "gone". */
const retired = new Map()
/** In-flight `createThread` calls, keyed by parent session id. */
const creating = new Map()

const log = (message) => {
  try {
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    /* diagnostics are best-effort */
  }
}

function threadOf(threadId) {
  const thread = threads.get(threadId)
  if (thread === undefined) throw fail('not-found', `unknown thread ${threadId}`, 404)
  return thread
}

/** Is the panel on screen right now (not merely "was opened at some point")? */
function panelOpen(thread) {
  return thread.settings.open && Date.now() - thread.openPingAt <= OPEN_STALE_MS
}

/** The panel polls continuously; every poll proves it is still on screen. */
function touchPanel(thread) {
  if (thread.settings.open) thread.openPingAt = Date.now()
}

/** Close the gate when the panel stopped reporting (tab closed, renderer gone). */
function sweepPanel(thread) {
  if (!thread.settings.open) return
  if (Date.now() - thread.openPingAt <= OPEN_STALE_MS) return
  thread.settings.open = false
  thread.openPingAt = 0
  applySettings(thread)
  log(`panel considered closed after ${OPEN_STALE_MS}ms without a poll on ${thread.threadId}`)
}

/** Text parts of one content block list, images reduced to their metadata. */
function toParts(content, messageId) {
  const parts = []
  const blocks = Array.isArray(content) ? content : []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block?.type === 'image' && block.attachment) {
      parts.push({
        type: 'image',
        attachmentId: `${messageId}:${index}`,
        mediaType: block.attachment.mediaType,
        name: block.attachment.name,
      })
    }
  }
  return parts
}

/** Fold the thread's durable log into renderable rows. Tool events are skipped. */
/**
 * Sessions record more than the user's own words: time-context snapshots,
 * runtime context, step tails and skill catalogs all arrive as `user/message`.
 * Only `source.kind === 'user'` is something the human actually typed.
 */
function isTypedByUser(event) {
  const kind = event?.data?.source?.kind
  return kind === undefined || kind === 'user'
}

function messagesOf(agent) {
  let events = []
  try {
    events = agent.session.snapshotEvents()
  } catch {
    return []
  }
  const rows = []
  for (const event of events) {
    if (event?.type === 'user/message' && event.data && isTypedByUser(event)) {
      rows.push({
        id: event.data.id,
        role: 'user',
        status: 'done',
        at: event.time,
        parts: toParts(event.data.content, event.data.id),
      })
    } else if (event?.type === 'assistant/message' && event.data?.message) {
      const message = event.data.message
      rows.push({
        id: message.id,
        role: 'assistant',
        status: 'done',
        at: event.time,
        parts: toParts(message.content, message.id),
      })
    }
  }
  return rows.slice(-200)
}

function statusOf(agent) {
  const status = typeof agent.status === 'string' ? agent.status : 'idle'
  return status === 'idle' ? 'idle' : 'running'
}

function snapshotOf(thread, sinceVersion) {
  touchPanel(thread)
  const agent = thread.handle.agent
  const status = statusOf(agent)
  const model = modelOf(agent) ?? hintOf(thread)
  const settings = { ...thread.settings }
  const approval = thread.approval === undefined ? undefined : { id: thread.approval.id, at: thread.approval.at }
  if (sinceVersion !== undefined && sinceVersion === thread.version) {
    return { version: thread.version, status, model, settings, approval }
  }
  return {
    version: thread.version,
    status,
    model,
    settings,
    approval,
    messages: messagesOf(agent),
    live: thread.live.text === '' ? undefined : thread.live.text,
  }
}

function modelOf(agent) {
  try {
    const current = agent.model?.current?.()
    if (current === undefined || current === null) return undefined
    return {
      provider: current.provider,
      id: current.model ?? current.id,
      reasoningEffort: current.reasoningEffort,
      label: [current.provider, current.model ?? current.id].filter(Boolean).join(' / '),
    }
  } catch {
    return undefined
  }
}

/** What the thread was last known to run on, for hosts where a blank agent
 *  reports no selection until its first turn. */
function hintOf(thread) {
  const hint = thread?.modelHint
  if (hint === undefined || typeof hint.provider !== 'string' || typeof hint.model !== 'string') {
    return undefined
  }
  return {
    provider: hint.provider,
    id: hint.model,
    reasoningEffort: hint.reasoningEffort,
    label: [hint.provider, hint.model].filter(Boolean).join(' / '),
  }
}

/** The host model catalog the composer uses, normalized for this panel. The
 *  service is probed structurally instead of injected: a deployment without it
 *  (headless, older host) degrades to `available: false` instead of a dead tab. */
async function catalogOf(ctx) {
  const service = ctx.get('sessionController')
  if (service?.modelCatalog === undefined) return { available: false, groups: [], failures: [] }
  try {
    const catalog = await service.modelCatalog()
    return {
      available: true,
      ...(catalog?.default === undefined ? {} : { default: catalog.default }),
      groups: Array.isArray(catalog?.groups) ? catalog.groups : [],
      failures: Array.isArray(catalog?.failures) ? catalog.failures : [],
    }
  } catch (error) {
    return {
      available: false,
      groups: [],
      failures: [{ id: 'host', message: String(error?.message ?? error) }],
    }
  }
}

/** `reasoningEffort` is branded in the LLM package; the brand is a runtime
 *  identity, but importing it keeps the value honest when the package resolves. */
async function brandedEffort(value) {
  try {
    const llm = await import('@deepseek-ai/dsh-llm')
    if (typeof llm?.ReasoningEffortId === 'function') return llm.ReasoningEffortId(value)
  } catch {
    /* plain id is accepted by select() */
  }
  return value
}

/**
 * The model a fresh side thread should start on: whatever the main thread is
 * using right now. `model.current()` can be empty before a turn settles, so we
 * also replay the last `model/selection` event and, failing that, the catalog
 * default.
 */
async function selectionFor(ctx, parent) {
  const same = (value) =>
    value !== null &&
    typeof value === 'object' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    value.provider !== '' &&
    value.model !== ''
  try {
    const direct = parent?.model?.current?.()
    if (same(direct)) {
      return {
        provider: direct.provider,
        model: direct.model,
        reasoningEffort: direct.reasoningEffort,
      }
    }
  } catch {
    /* no model service on this agent */
  }
  try {
    const events = parent?.session?.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0 && index > events.length - 600; index -= 1) {
      const event = events[index]
      if (event?.type !== 'model/selection') continue
      const data = event.data ?? {}
      if (!same(data)) continue
      return {
        provider: data.provider,
        model: data.model,
        reasoningEffort: data.reasoningEffort,
      }
    }
  } catch {
    /* history unavailable */
  }
  try {
    const fallback = ctx.get('sessionController')?.modelCatalog?.()?.default
    if (same(fallback)) {
      return { provider: fallback.provider, model: fallback.model, reasoningEffort: fallback.reasoningEffort }
    }
  } catch {
    /* no catalog */
  }
  return {}
}

/** Fill in and bind a model hint for a thread that has none — happens when a
 *  thread survives from a build that never recorded one, or when the host does
 *  not report a selection for a freshly resumed agent. */
async function bindModelHint(ctx, thread) {
  if (thread === undefined || thread.modelHint !== undefined) return
  if (modelOf(thread.handle?.agent) !== undefined) return
  const parent = ctx.get('agents')?.get?.(thread.parentSessionId)
  const selection = await selectionFor(ctx, parent)
  if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return
  thread.modelHint = { ...selection }
  try {
    await thread.handle.agent.model?.select?.({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: await brandedEffort(selection.reasoningEffort) }),
    })
  } catch (error) {
    log(`model hint bind failed ${thread.threadId}: ${error?.message ?? error}`)
  }
  void putEntry(thread.parentSessionId, { model: { ...selection } })
}

async function createThread(ctx, parentSessionId) {
  const agents = ctx.get('agents')
  if (agents === undefined) throw fail('unavailable', 'the agents service is unavailable', 503)
  const parent = agents.get?.(parentSessionId)
  if (parent === undefined || parent === null) {
    throw fail('not-found', `main session ${parentSessionId} is not live`, 404)
  }
  const session = parent.session
  if (session === undefined) throw fail('unavailable', 'the main session has no agent session', 503)

  const selection = await selectionFor(ctx, parent)
  const agentOptions = {}
  if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
    agentOptions.provider = selection.provider
    agentOptions.model = selection.model
  }
  if (selection.reasoningEffort !== undefined) agentOptions.reasoningEffort = selection.reasoningEffort

  const header = session.header ?? {}
  const threadId = `session-${randomUUID()}`
  const meta = {
    parentSession: session.id,
    origin: 'subagent',
    delegationDepth: (header.delegationDepth ?? 0) + 1,
  }
  // The child must not claim a different workspace than its parent.
  if (typeof header.cwd === 'string' && header.cwd !== '') meta.cwd = header.cwd

  const handle = await agents.create({
    sessionId: threadId,
    meta,
    agentOptions,
    setup: installZeroTools,
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  })

  try {
    await handle.agent.inbox?.clear?.()
  } catch {
    /* blank thread: nothing to clear */
  }

  // A brand-new agent may not report a selection at all; bind the main thread's
  // model explicitly so the panel never opens on "未知".
  if (typeof selection.provider === 'string' && typeof selection.model === 'string') {
    try {
      await handle.agent.model?.select?.({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: await brandedEffort(selection.reasoningEffort) }),
      })
    } catch (error) {
      log(`model bind failed ${threadId}: ${error?.message ?? error}`)
    }
  }

  /** @type {Thread} */
  const thread = {
    threadId,
    parentSessionId,
    ctx,
    handle,
    cwd: meta.cwd,
    version: 0,
    live: { text: '', attempt: undefined, nextIndex: 0 },
    settings: { ...DEFAULT_SETTINGS },
    modelHint:
      typeof selection.provider === 'string' && typeof selection.model === 'string'
        ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
        : undefined,
    openPingAt: 0,
    approval: undefined,
    parentTool: undefined,
    sideTool: undefined,
  }
  threads.set(threadId, thread)
  parentIndex.set(parentSessionId, threadId)
  const previous = await entryOf(parentSessionId)
  if (
    previous?.state === 'live' &&
    typeof previous.threadId === 'string' &&
    previous.threadId !== '' &&
    previous.threadId !== threadId
  ) {
    // Two windows opening the same main session can both pass the "no entry
    // yet" check; whoever writes the registry first wins. Drop the loser so a
    // main session never ends up with two side threads.
    log(`thread create raced ${threadId} lost to ${previous.threadId}`)
    threads.delete(threadId)
    parentIndex.delete(parentSessionId)
    try {
      await handle.dispose?.()
    } catch {
      /* already gone */
    }
    try {
      await deleteSessionArtifact(threadId, meta.cwd)
    } catch (error) {
      log(`race artifact delete failed ${threadId}: ${error?.message ?? error}`)
    }
    const winner = await resumeThread(ctx, parentSessionId, previous)
    if (winner !== undefined) return winner
  }
  const history = [...(Array.isArray(previous?.history) ? previous.history : []), threadId].slice(-50)
  await putEntry(parentSessionId, {
    threadId,
    state: 'live',
    cwd: meta.cwd,
    settings: { ...thread.settings },
    ...(thread.modelHint === undefined ? {} : { model: { ...thread.modelHint } }),
    history,
  })
  log(`thread created ${threadId} for ${parentSessionId}`)
  return thread
}

async function disposeThread(thread) {
  try {
    thread.approval?.settle?.(false)
  } catch {
    /* already settled */
  }
  detachParentTool(thread)
  detachSideTool(thread)
  try {
    await thread.handle.dispose?.()
  } catch {
    /* the agent may already be gone after a host restart */
  }
  threads.delete(thread.threadId)
  if (parentIndex.get(thread.parentSessionId) === thread.threadId) {
    parentIndex.delete(thread.parentSessionId)
  }
}

/* ─────────────────────── cross-session reading ─────────────────────── */

/** The last message of one role whose text is non-empty, or ''. */
function lastTextOf(agent, role) {
  let events = []
  try {
    events = agent.session.snapshotEvents()
  } catch {
    return ''
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const message =
      event?.type === 'user/message' ? event.data : event?.type === 'assistant/message' ? event.data?.message : undefined
    if (message === undefined) continue
    const eventRole = event.type === 'user/message' ? 'user' : 'assistant'
    if (eventRole !== role) continue
    if (eventRole === 'user' && !isTypedByUser(event)) continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}

/** Render the last `limit` messages of a session as plain text (tools skipped). */
function transcriptOf(agent, limit) {
  const rows = messagesOf(agent).slice(-Math.max(1, Math.min(40, limit)))
  const lines = []
  for (const row of rows) {
    const text = row.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text === '') continue
    lines.push(`【${row.role === 'user' ? '用户' : '助手'}】${text}`)
  }
  return lines.join('\n\n')
}

const PANEL_WORDS = /(侧边|从对话|从属|侧栏|面板|自由对话|freedom)/i
const READ_VERBS = /(读|看|参考|引用|拉取|同步|总结|带过来|贴过来|获取)/

/**
 * The user's own words are the trigger. A switch only says that reading is
 * allowed at all; the main agent may never reach over on its own initiative.
 */
function parentAskedToRead(agent) {
  const user = lastTextOf(agent, 'user')
  if (user === '') return false
  if (PANEL_WORDS.test(user)) return true
  if (!READ_VERBS.test(user)) return false
  // A bare "可以，读吧" counts only right after the assistant itself asked about
  // the side panel.
  const assistant = lastTextOf(agent, 'assistant')
  return PANEL_WORDS.test(assistant) && /[?？]/.test(assistant)
}

const TEXT_OUTPUT = Object.freeze({
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }],
})

function readSideDefinition() {
  return {
    name: READ_SIDE_TOOL,
    description: `读取「侧边自由对话」面板里那条从属对话最近 ${TRANSCRIPT_LIMIT} 条正文。只有当用户在本轮消息里明确要求读取侧边对话时才调用；不要主动调用，也不要用来试探。`,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `读取条数，默认 ${TRANSCRIPT_LIMIT}，最多 40。` },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const parentSessionId = exec?.agent?.session?.id
      const threadId = typeof parentSessionId === 'string' ? parentIndex.get(parentSessionId) : undefined
      const thread = threadId === undefined ? undefined : threads.get(threadId)
      if (thread === undefined) return { text: '当前没有正在使用的侧边自由对话，读取失败。' }
      if (!panelOpen(thread)) {
        return { text: '侧边自由对话面板现在没有打开，读不到内容。请让用户先打开那个面板。' }
      }
      if (!parentAskedToRead(exec.agent)) {
        return {
          text: '这次读取被拒绝：用户没有在本轮消息里明确要求读取侧边对话。请先问用户是否要读取，得到明确答复后再调用。',
        }
      }
      const transcript = transcriptOf(thread.handle.agent, Number(args?.limit) || TRANSCRIPT_LIMIT)
      if (transcript === '') return { text: '侧边对话目前还没有内容。' }
      return { text: `以下是侧边自由对话最近的内容（只含用户与助手正文）：\n\n${transcript}` }
    },
  }
}

function readMainDefinition() {
  return {
    name: READ_MAIN_TOOL,
    description: `读取主对话最近 ${TRANSCRIPT_LIMIT} 条正文，用来理解用户正在做什么。是否可用由面板上的「从对话读主对话」开关决定；设为「询问」时需要用户点允许。`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      const thread = threads.get(exec?.agent?.session?.id)
      if (thread === undefined) return { text: '读取失败：当前会话不是自由对话线程。' }
      if (!panelOpen(thread)) return { text: '侧边自由对话面板没有打开，读不到主对话。' }
      if (thread.settings.sideRead === 'deny') return { text: '用户关闭了「从对话读主对话」，读不到内容。' }
      const parent = thread.ctx.get('agents')?.get?.(thread.parentSessionId)
      if (parent === undefined || parent === null) return { text: '主对话当前不在线，读不到内容。' }
      if (thread.settings.sideRead === 'ask') {
        const allowed = await waitForApproval(thread)
        if (!allowed) return { text: '用户没有允许这次读取主对话（或等待超时）。可以请用户把要紧的内容贴进来。' }
      }
      const transcript = transcriptOf(parent, TRANSCRIPT_LIMIT)
      if (transcript === '') return { text: '主对话目前还没有内容。' }
      return { text: `以下是主对话最近的内容（只含用户与助手正文）：\n\n${transcript}` }
    },
  }
}

/** Park the tool call until the panel answers (or the wait times out). */
function waitForApproval(thread) {
  return new Promise((resolve) => {
    const id = `apr-${randomUUID()}`
    const record = { id, at: Date.now(), timer: undefined, settle: undefined }
    record.settle = (allow) => {
      if (thread.approval !== record) return
      thread.approval = undefined
      clearTimeout(record.timer)
      thread.version += 1
      log(`approval ${id} ${allow === true ? 'allowed' : 'denied'}`)
      resolve(allow === true)
    }
    record.timer = setTimeout(() => record.settle(false), APPROVAL_TIMEOUT_MS)
    record.timer.unref?.()
    thread.approval = record
    thread.version += 1
    log(`approval requested ${id} on ${thread.threadId}`)
  })
}

function applyParentTool(thread) {
  const want = panelOpen(thread) && thread.settings.mainRead
  if (!want) {
    detachParentTool(thread)
    return
  }
  if (thread.parentTool !== undefined) return
  let parent
  try {
    parent = thread.ctx.get('agents')?.get?.(thread.parentSessionId)
  } catch {
    parent = undefined
  }
  const tools = parent?.ctx?.tools
  if (tools === undefined) {
    log(`parent tool skipped: main session ${thread.parentSessionId} is not live`)
    return
  }
  try {
    thread.parentTool = { dispose: tools.register(readSideDefinition()) }
    log(`parent tool attached on ${thread.parentSessionId}`)
  } catch (error) {
    log(`parent tool failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function detachParentTool(thread) {
  const tool = thread.parentTool
  if (tool === undefined) return
  thread.parentTool = undefined
  try {
    tool.dispose?.()
  } catch {
    /* the main agent may be gone */
  }
}

function applySideTool(thread) {
  const want = thread.settings.sideRead !== 'deny'
  if (!want) {
    detachSideTool(thread)
    return
  }
  if (thread.sideTool !== undefined) return
  const tools = thread.handle.agent?.ctx?.tools
  if (tools === undefined) return
  try {
    thread.sideTool = { dispose: tools.register(readMainDefinition()) }
    log(`side tool attached on ${thread.threadId}`)
  } catch (error) {
    log(`side tool failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function detachSideTool(thread) {
  const tool = thread.sideTool
  if (tool === undefined) return
  thread.sideTool = undefined
  try {
    tool.dispose?.()
  } catch {
    /* the side agent may be gone */
  }
}

/**
 * Re-shape the side thread's visible tool set. `restrict()` masks inherited
 * (global) names only, so the agent's own layer — where our read tool lives and
 * where dsh-ops publishes bash — is untouched; execution is gated separately.
 */
function applyWebRestriction(thread) {
  const agent = thread.handle.agent
  const tools = agent?.ctx?.tools
  if (tools === undefined) return
  for (const lift of liftsByAgent.get(agent) ?? []) {
    try {
      lift()
    } catch {
      /* already dropped */
    }
  }
  liftsByAgent.delete(agent)
  let names = []
  try {
    const schemas = tools.schemas?.(agent)
    if (Array.isArray(schemas)) names = schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string')
  } catch {
    /* schemas is optional */
  }
  if (names.length === 0) return
  const hide = names.filter((name) => name !== RUN_CODE && !(thread.settings.web && WEB_TOOL_NAMES.includes(name)))
  try {
    const lift = thread.settings.web ? tools.restrict({ allow: WEB_TOOL_NAMES.filter((name) => names.includes(name)) }) : tools.restrict({ deny: hide })
    liftsByAgent.set(agent, [lift])
    log(`tools: web=${thread.settings.web} hid ${hide.length}`)
    return
  } catch {
    /* `allow` may not be a supported shape here: deny the rest one by one */
  }
  const lifts = []
  for (const name of hide) {
    try {
      lifts.push(tools.restrict({ deny: [name] }))
    } catch {
      /* own-layer names cannot be masked */
    }
  }
  liftsByAgent.set(agent, lifts)
  log(`tools: web=${thread.settings.web} hid ${lifts.length}/${hide.length} one by one`)
}

function applySettings(thread) {
  applyParentTool(thread)
  applySideTool(thread)
}

/** Names the pre-execute gate lets through for this thread right now. */
function allowedTools(thread) {
  const allowed = new Set()
  if (panelOpen(thread) && thread.settings.sideRead !== 'deny') allowed.add(READ_MAIN_TOOL)
  if (thread.settings.web) for (const name of WEB_TOOL_NAMES) allowed.add(name)
  return allowed
}

/* ────────────────────────────── api ────────────────────────────── */

function buildApi(ctx) {
  const api = {}

  /**
   * Resolve the panel without creating anything: live thread, resumable
   * mapping, archived tombstone, or `empty`. Mounting the panel must not mint a
   * child session, or every idle open would leave an empty transcript behind.
   */
  api.peek = async (payload) => {
    const parentSessionId = String(payload?.parentSessionId ?? '')
    if (parentSessionId === '') throw fail('bad-request', 'parentSessionId is required')
    await sweepLifecycle(ctx)
    const known = parentIndex.get(parentSessionId)
    const existing = known === undefined ? undefined : threads.get(known)
    if (existing !== undefined) {
      await bindModelHint(ctx, existing)
      return { threadId: existing.threadId, state: 'live', snapshot: snapshotOf(existing) }
    }
    const entry = await entryOf(parentSessionId)
    if (entry?.state === 'archived') {
      const alive = await parentSessionAlive(ctx, parentSessionId)
      const archived = archivedSessionIds(ctx)
      const stillArchived = archived === null ? true : archived.has(parentSessionId)
      if (!alive || stillArchived) return { threadId: null, state: 'archived', snapshot: null }
      await putEntry(parentSessionId, { threadId: null, state: 'live', settings: entry.settings })
      log(`tombstone cleared (main unarchived) parent=${parentSessionId}`)
      return { threadId: null, state: 'empty', snapshot: null }
    }
    if (typeof entry?.threadId === 'string' && entry.threadId !== '') {
      if (!(await parentSessionAlive(ctx, parentSessionId))) {
        await retireThread(ctx, parentSessionId, entry, 'deleted')
        return { threadId: null, state: 'archived', snapshot: null }
      }
      const resumed = await resumeThread(ctx, parentSessionId, entry)
      if (resumed !== undefined) {
        return { threadId: resumed.threadId, state: 'live', snapshot: snapshotOf(resumed) }
      }
    }
    return { threadId: null, state: 'empty', snapshot: null }
  }

  api.ensure = async (payload) => {
    const parentSessionId = String(payload?.parentSessionId ?? '')
    if (parentSessionId === '') throw fail('bad-request', 'parentSessionId is required')
    await sweepLifecycle(ctx)
    const known = parentIndex.get(parentSessionId)
    const existing = known === undefined ? undefined : threads.get(known)
    if (existing !== undefined) {
      await bindModelHint(ctx, existing)
      return { threadId: existing.threadId, state: 'live', snapshot: snapshotOf(existing) }
    }
    const entry = await entryOf(parentSessionId)
    if (entry?.state === 'archived') {
      // A tombstone only stands while the main session is still archived. If the
      // user unarchived it, the deleted side thread should come back as a fresh
      // empty chat instead of a permanent notice.
      const alive = await parentSessionAlive(ctx, parentSessionId)
      const archived = archivedSessionIds(ctx)
      const stillArchived = archived === null ? true : archived.has(parentSessionId)
      if (!alive || stillArchived) return { threadId: null, state: 'archived', snapshot: null }
      await putEntry(parentSessionId, { threadId: null, state: 'live', settings: entry.settings })
      log(`tombstone cleared (main unarchived) parent=${parentSessionId}`)
    }
    if (typeof entry?.threadId === 'string' && entry.threadId !== '') {
      if (!(await parentSessionAlive(ctx, parentSessionId))) {
        await retireThread(ctx, parentSessionId, entry, 'deleted')
        return { threadId: null, state: 'archived', snapshot: null }
      }
      const resumed = await resumeThread(ctx, parentSessionId, entry)
      if (resumed !== undefined) {
        return { threadId: resumed.threadId, state: 'live', snapshot: snapshotOf(resumed) }
      }
    }
    // The panel mounts twice under React's strict mode; without this the second
    // call mints a second child and the first one is orphaned in the store.
    const pending = creating.get(parentSessionId)
    if (pending !== undefined) {
      const thread = await pending
      return { threadId: thread.threadId, state: 'live', snapshot: snapshotOf(thread) }
    }
    const promise = createThread(ctx, parentSessionId)
    creating.set(parentSessionId, promise)
    try {
      const thread = await promise
      return { threadId: thread.threadId, state: 'live', snapshot: snapshotOf(thread) }
    } finally {
      creating.delete(parentSessionId)
    }
  }

  api.snapshot = async (payload) => {
    const threadId = String(payload?.threadId ?? '')
    if (!threads.has(threadId) && retired.has(threadId)) {
      // Racing a sweep: the panel asked about a thread that this process just
      // retired. Answer with the tombstone instead of a bare 404.
      return { threadId: null, state: 'archived', snapshot: null }
    }
    const thread = threadOf(threadId)
    sweepPanel(thread)
    void sweepLifecycle(ctx)
    const version = typeof payload?.version === 'number' ? payload.version : undefined
    return snapshotOf(thread, version)
  }

  api.send = async (payload) => {
    const thread = threadOf(String(payload?.threadId ?? ''))
    const agent = thread.handle.agent
    if (statusOf(agent) === 'running') throw fail('busy', '上一轮还在生成，先停止或等它结束', 409)
    const parts = Array.isArray(payload?.parts) ? payload.parts : []
    if (parts.length === 0) throw fail('bad-request', 'parts is required')

    const text = parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
    if (text.trim() === '') throw fail('bad-request', '消息不能为空')

    const images = parts.filter((part) => part?.type === 'image' && typeof part.data === 'string')
    const content = [{ type: 'text', text }]
    if (images.length > 0) {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw fail('unavailable', 'attachments service is unavailable', 503)
      const admitted = await attachments.admitPromptContent(
        images.map((part) => ({
          type: 'image',
          mediaType: part.mediaType,
          name: part.name,
          data: part.data,
        })),
      )
      content.push(...admitted)
    }

    const message = userMessage(content)
    agent.followup(message)
    thread.version += 1
    return { version: thread.version, messageId: message.id }
  }

  api.cancel = async (payload) => {
    const thread = threadOf(String(payload?.threadId ?? ''))
    try {
      thread.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (error) {
      throw fail('internal', error instanceof Error ? error.message : String(error), 500)
    }
    return { version: thread.version }
  }

  api.clear = async (payload) => {
    const thread = threadOf(String(payload?.threadId ?? ''))
    const parentSessionId = thread.parentSessionId
    const staleId = thread.threadId
    const staleCwd = thread.cwd
    await disposeThread(thread)
    // 清空 means deleting this side conversation outright — the next message
    // opens a fresh one. Leaving a replacement behind (or its transcript on
    // disk) is what used to litter the main session with phantom subagents.
    try {
      await deleteSessionArtifact(staleId, staleCwd)
    } catch (error) {
      log(`clear artifact delete failed ${staleId}: ${error?.message ?? error}`)
    }
    retired.set(staleId, { parentSessionId, at: Date.now() })
    parentIndex.delete(parentSessionId)
    await dropEntry(parentSessionId)
    log(`cleared ${staleId} for ${parentSessionId}`)
    return { threadId: null, state: 'empty', cleared: true }
  }

  /** Leave the archived tombstone behind and start a brand-new thread. */
  api.revive = async (payload) => {
    const parentSessionId = String(payload?.parentSessionId ?? '')
    if (parentSessionId === '') throw fail('bad-request', 'parentSessionId is required')
    const known = parentIndex.get(parentSessionId)
    const existing = known === undefined ? undefined : threads.get(known)
    if (existing !== undefined) return { threadId: existing.threadId, state: 'live', snapshot: snapshotOf(existing) }
    await dropEntry(parentSessionId)
    const fresh = await createThread(ctx, parentSessionId)
    return { threadId: fresh.threadId, state: 'live', snapshot: snapshotOf(fresh) }
  }

  api.setSettings = async (payload) => {
    const thread = threadOf(String(payload?.threadId ?? ''))
    const patch = payload?.patch
    if (typeof patch !== 'object' || patch === null) throw fail('bad-request', 'patch must be an object')
    if (patch.open !== undefined) {
      if (typeof patch.open !== 'boolean') throw fail('bad-request', 'open must be a boolean')
      thread.settings.open = patch.open
      thread.openPingAt = patch.open ? Date.now() : 0
    }
    if (patch.mainRead !== undefined) {
      if (typeof patch.mainRead !== 'boolean') throw fail('bad-request', 'mainRead must be a boolean')
      thread.settings.mainRead = patch.mainRead
    }
    if (patch.web !== undefined) {
      if (typeof patch.web !== 'boolean') throw fail('bad-request', 'web must be a boolean')
      thread.settings.web = patch.web
      applyWebRestriction(thread)
    }
    if (patch.sideRead !== undefined) {
      if (!SIDE_READ_MODES.includes(patch.sideRead)) throw fail('bad-request', 'sideRead must be allow, ask or deny')
      thread.settings.sideRead = patch.sideRead
    }
    applySettings(thread)
    thread.version += 1
    void putEntry(thread.parentSessionId, { settings: { ...thread.settings } })
    log(
      `settings ${thread.threadId} open=${thread.settings.open} mainRead=${thread.settings.mainRead} sideRead=${thread.settings.sideRead} web=${thread.settings.web}`,
    )
    return snapshotOf(thread)
  }

  api.resolveApproval = async (payload) => {
    const thread = threadOf(String(payload?.threadId ?? ''))
    const record = thread.approval
    if (record === undefined) throw fail('not-found', '没有待处理的确认请求', 404)
    if (typeof payload?.approvalId === 'string' && payload.approvalId !== record.id) {
      throw fail('not-found', '确认请求已被处理', 404)
    }
    record.settle(payload?.allow === true)
    return { version: thread.version }
  }

  /** The picker's data: provider groups, each model's optional reasoning
   *  efforts. Read-only and cheap enough to refetch on every open. */
  api.catalog = async () => catalogOf(ctx)

  /** Pin one route (and optionally one reasoning effort) on this thread. The
   *  choice is recorded as a `model/selection` session event by AgentModel, so
   *  it survives a cold resume and never touches the profile default. */
  api.setModel = async (payload) => {
    const thread = threadOf(String(payload?.threadId ?? ''))
    const provider = String(payload?.provider ?? '')
    const model = String(payload?.model ?? '')
    if (provider === '' || model === '') throw fail('bad-request', 'provider and model are required')
    const rawEffort = payload?.reasoningEffort
    if (rawEffort !== undefined && (typeof rawEffort !== 'string' || rawEffort === '')) {
      throw fail('bad-request', 'reasoningEffort must be a non-empty string')
    }
    const selection = {
      provider,
      model,
      ...(rawEffort === undefined ? {} : { reasoningEffort: rawEffort }),
    }
    const llm = ctx.get('llm')
    if (typeof llm?.resolveCallConfig === 'function') {
      let resolved
      try {
        resolved = await llm.resolveCallConfig({
          provider,
          model,
          ...(selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: await brandedEffort(selection.reasoningEffort) }),
        })
      } catch (error) {
        throw fail(
          'bad-request',
          `model "${provider}/${model}" is unavailable: ${String(error?.message ?? error)}`,
          400,
        )
      }
      if (typeof resolved?.provider === 'string') selection.provider = resolved.provider
      if (typeof resolved?.model === 'string') selection.model = resolved.model
      if (resolved?.reasoningEffort !== undefined) selection.reasoningEffort = String(resolved.reasoningEffort)
    }
    const handle = thread.handle.agent?.model
    if (typeof handle?.select !== 'function') throw fail('sidechat-error', 'this agent cannot switch models', 503)
    await handle.select({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: await brandedEffort(selection.reasoningEffort) }),
    })
    thread.modelHint = { ...selection }
    thread.version += 1
    void putEntry(thread.parentSessionId, { model: { ...selection } })
    log(
      `model ${thread.threadId} ${selection.provider}/${selection.model}` +
        (selection.reasoningEffort === undefined ? '' : ` effort=${selection.reasoningEffort}`),
    )
    return snapshotOf(thread)
  }

  return api
}

/* ────────────────────────────── plugin ────────────────────────────── */

export const apply = (ctx) => {
  log(`host-half apply build=p3 sweep=${SWEEP_MS}ms`)

  const api = buildApi(ctx)
  const fence = (req) => {
    try {
      return ctx.get('connection')?.requestRejection(req) === undefined
    } catch {
      return true
    }
  }

  // Streaming deltas never reach the session log, so the bridge keeps the
  // in-flight text per thread and bumps the version the client polls on.
  try {
    ctx.on('agent/assistant-stream', (payload) => {
      const thread = threads.get(payload?.agent?.session?.id)
      if (thread === undefined) return
      const frame = payload.frame
      if (frame?.type === 'start') {
        thread.live = { text: '', attempt: frame.attemptId, nextIndex: 0 }
        thread.version += 1
        return
      }
      if (frame?.type === 'chunk') {
        if (frame.index !== thread.live.nextIndex) {
          thread.live = { text: '', attempt: undefined, nextIndex: 0 }
          return
        }
        thread.live.nextIndex += 1
        if (frame.chunk?.type === 'text-delta') {
          thread.live.text += frame.chunk.text ?? ''
          thread.version += 1
        }
        return
      }
      if (frame?.type === 'end') {
        thread.live = { text: '', attempt: undefined, nextIndex: 0 }
        thread.version += 1
      }
    })
  } catch (error) {
    log(`assistant-stream subscription failed: ${error?.message ?? error}`)
  }

  try {
    ctx.on('session/event', (session, event) => {
      const thread = threads.get(session?.id)
      if (thread === undefined) return
      thread.version += 1
      if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error') {
        log(`turn error: ${event.data.reason.error?.message ?? 'unknown'}`)
      }
    })
  } catch (error) {
    log(`session/event subscription failed: ${error?.message ?? error}`)
  }

  // Hard gate: visibility alone is not enough. dsh-ops publishes `ops_bash`
  // into the agent's OWN tool layer on `agent/created`, and `restrict()` masks
  // inherited names only — so this check, which runs before any tool body,
  // is the boundary that actually holds.
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const sessionId = exec?.agent?.session?.id
      const thread = typeof sessionId === 'string' ? threads.get(sessionId) : undefined
      if (thread === undefined) {
        return typeof next === 'function' ? next() : undefined
      }
      // Allow-list, not deny-list: the panel's switches decide what the side
      // thread may touch, and everything else stays blocked no matter how it got
      // published into scope.
      if (allowedTools(thread).has(exec?.name)) {
        return typeof next === 'function' ? next() : undefined
      }
      log(`denied tool ${exec?.name ?? '?'} on ${sessionId}`)
      return { kind: 'deny', reason: '侧边自由对话没有本地执行权限（这个工具不在面板允许的范围内）' }
    })
  } catch (error) {
    log(`pre-execute gate failed: ${error?.message ?? error}`)
  }

  // Standing instructions, scoped to our own agents (everyone else gets '').
  try {
    ctx.systemPrompt.section({
      name: 'freedomchat:side-thread',
      order: 40,
      text: ({ agent }) => sidePromptFor(agent),
    })
  } catch (error) {
    log(`system prompt section failed: ${error?.message ?? error}`)
  }

  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    log('webServer unavailable — no HTTP bridge')
    return
  }

  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            if (!fence(req)) {
              writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
              return
            }
            if (req.method !== 'POST') {
              writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST only' } })
              return
            }
            const pathname = new URL(req.url ?? '/', 'http://host.invalid').pathname
            const method = pathname.startsWith(`${API_PREFIX}/`)
              ? pathname.slice(API_PREFIX.length + 1)
              : undefined
            if (method === undefined || method.includes('/')) {
              writeError(res, fail('not-found', 'unknown freedomchat API method', 404))
              return
            }
            const handler = Object.hasOwn(api, method) ? api[method] : undefined
            if (typeof handler !== 'function') {
              writeError(res, fail('not-found', `unknown freedomchat API method "${method}"`, 404))
              return
            }
            try {
              writeOk(res, await handler(await readJsonBody(req)))
            } catch (error) {
              writeError(res, error)
            }
          },
        }),
      'dsh-freedomchat: /freedomchat/api',
    )
    log('api ready')
    void sweepLifecycle(ctx)
    // No client polling? Then nothing else would notice the archive, and the
    // user asked for "归档就清空" regardless of the panel being open.
    if (SWEEP_MS > 0) {
      ctx.effect(
        () => {
          const timer = setInterval(() => {
            void sweepLifecycle(ctx)
          }, SWEEP_MS)
          if (typeof timer.unref === 'function') timer.unref()
          return () => clearInterval(timer)
        },
        'dsh-freedomchat: lifecycle sweep',
      )
    }
  } catch (error) {
    log(`route registration failed: ${error?.message ?? error}`)
  }

  ctx.effect(
    () => () => {
      for (const thread of [...threads.values()]) void disposeThread(thread)
    },
    'dsh-freedomchat: dispose threads',
  )
}