/**
 * Host-half smoke test: mounts `lib/index.js` on a fake Cordis context and
 * drives the HTTP bridge the way the browser will, so wiring bugs surface
 * before a DSH restart.
 *
 * Run: node scripts/host-smoke.mjs
 */
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const sandbox = await mkdtemp(join(tmpdir(), 'freedomchat-smoke-'))
process.env.FREEDOMCHAT_STATE_DIR = join(sandbox, 'state')
process.env.FREEDOMCHAT_SESSIONS_ROOT = join(sandbox, 'sessions')
process.env.FREEDOMCHAT_SWEEP_MS = '0'
process.env.FREEDOMCHAT_BOOT_LOG = join(sandbox, 'boot.log')
const registryFile = join(process.env.FREEDOMCHAT_STATE_DIR, 'threads.json')
const { apply } = await import('../lib/index.js')
const { sessionDirOf, encodeProjectSegment, deleteSessionArtifact } = await import('../lib/state.js')

/*
 * The project-folder encoding is load-bearing: every "delete this side thread"
 * path derives the folder from the cwd, and `rm(path,{force:true})` reports
 * success for a path that never existed. A wrong rule therefore deletes
 * nothing and looks healthy. These pairs are copied from real folders this
 * machine produced, so a regression fails here instead of on the user's disk.
 */
const SEGMENT_CASES = [
  ['C:\\Users\\MIS\\.dsh\\bot\\workspace', '--C-Users-MIS-.dsh-bot-workspace--'],
  ['D:\\DSH', '--D-DSH--'],
  ['D:\\DSH\\work', '--D-DSH-work--'],
  ['D:\\量化', '--D-~91CF~5316--'],
  ['E:\\User\\Desktop\\多aitest\\demo', '--E-User-Desktop-~591Aaitest-demo--'],
  [
    'E:\\User\\Documents\\deepseek-harness\\default-workspace',
    '--E-User-Documents-deepseek-harness-default-workspace--',
  ],
  ['E:\\Wegame', '--E-Wegame--'],
  ['E:\\Work\\STG\\岩石力学\\DSHtest', '--E-Work-STG-~5CA9~77F3~529B~5B66-DSHtest--'],
  [
    'E:\\Work\\STG\\岩石力学\\Growth cycylic deep learning',
    '--E-Work-STG-~5CA9~77F3~529B~5B66-Growth~0020cycylic~0020deep~0020learning--',
  ],
  [
    'E:\\Work\\STG\\岩石力学\\等幅循环荷载论文',
    '--E-Work-STG-~5CA9~77F3~529B~5B66-~7B49~5E45~5FAA~73AF~8377~8F7D~8BBA~6587--',
  ],
  [
    'E:\\Work\\课题组任务\\大断面软岩施工安全关键技术研究\\结题\\缺少材料补充',
    '--E-Work-~8BFE~9898~7EC4~4EFB~52A1-~5927~65AD~9762~8F6F~5CA9~65BD~5DE5~5B89~5168~5173~952E~6280~672F~7814~7A76-~7ED3~9898-~7F3A~5C11~6750~6599~8865~5145--',
  ],
]

const archivedIds = []
const persistedHeaders = new Map([
  ['session-parent', { id: 'session-parent', cwd: 'D:/DSH/work', origin: 'user' }],
])
const calls = []
const selections = []
const threadsCreated = []
const restrictions = []
const disposers = []

/* ───────────────────────── fake host services ───────────────────────── */

function makeAgent(id, events) {
  const agent = {
    id,
    status: 'idle',
    session: {
      id,
      header: { cwd: 'D:/DSH/work', delegationDepth: 0 },
      snapshotEvents: () => events,
    },
    model: (() => {
      let route = { provider: 'deepseek', model: 'deepseek-chat' }
      return {
        current: () => ({ ...route }),
        select(next) {
          route = { ...next }
          selections.push({ id, next })
        },
      }
    })(),
    inbox: { clear: async () => {} },
    followup(message) {
      agent.status = 'running'
      events.push({ type: 'user/message', time: new Date().toISOString(), data: message })
      return message.id
    },
    cancel() {
      agent.status = 'idle'
    },
  }
  // Per-agent scoped tool service, the shape the host gives every agent.
  agent.registrations = new Map()
  agent.ctx = {
    tools: {
      schemas: () => [
        { name: 'ops_bash' },
        { name: 'read_file' },
        { name: 'web_search' },
        { name: 'web_fetch' },
        { name: 'research' },
      ],
      restrict: (plan) => {
        restrictions.push(plan)
        return () => {}
      },
      register: (definition) => {
        agent.registrations.set(definition.name, definition)
        return () => {
          agent.registrations.delete(definition.name)
        }
      },
    },
  }
  return agent
}

const parentEvents = []
const parent = makeAgent('session-parent', parentEvents)

// A host where the main agent has not settled on a model yet: the panel must
// still open on the catalog default instead of showing "未知".
const silentParent = makeAgent('session-parent-silent', [])
silentParent.model = { current: () => undefined, select() {} }

// A second live main session used by the create-race test.
const raceParentAgent = makeAgent('session-parent-race', [])

const resumedAgents = []
let stripResumedModel = false
let onBeforeCreate = null

const agents = {
  get: (id) =>
    id === 'session-parent'
      ? parent
      : id === 'session-parent-silent'
        ? silentParent
        : id === 'session-parent-race'
          ? raceParentAgent
          : undefined,
  resume: async (options) => {
    calls.push(['agents.resume', options])
    const head = persistedHeaders.get(options.resumeSessionId)
    if (head === undefined) throw new Error(`no such session ${options.resumeSessionId}`)
    const agent = makeAgent(options.resumeSessionId, [])
    // Some hosts resume an agent that reports no selection at all.
    if (stripResumedModel) delete agent.model
    resumedAgents.push(agent)
    const agentCtx = {
      tools: {
        view: () => ({ restrictableNames: new Set(['ops_bash']) }),
        definitions: () => [],
        restrict: () => () => {},
      },
      effect: (fn) => {
        disposers.push(fn())
      },
      on: () => {},
    }
    await options.setup?.(agentCtx, agent)
    resumedAgents.push(agent)
    return { agent, dispose: async () => { agent.status = 'disposed' } }
  },
  create: async (options) => {
    if (onBeforeCreate !== null) {
      await onBeforeCreate(options)
      onBeforeCreate = null
    }
    calls.push(['agents.create', options])
    const events = []
    const agent = makeAgent(options.sessionId, events)
    // The host runs `setup` before 'agent/created'; mimic that ordering.
    const agentCtx = {
      tools: {
        view: () => ({ restrictableNames: new Set(['ops_bash', 'read_file', 'run_code']) }),
        definitions: () => [],
        restrict: (plan) => {
          restrictions.push(plan)
          return () => {}
        },
      },
      effect: (fn) => {
        disposers.push(fn())
      },
      on: () => {},
    }
    await options.setup?.(agentCtx, agent)
    threadsCreated.push(agent)
    return { agent, dispose: async () => { agent.status = 'disposed' } }
  },
}

const routeHandlers = []
const ctx = {
  get: (name) => {
    if (name === 'agents') return agents
    if (name === 'webServer') {
      return {
        register: (route) => {
          routeHandlers.push(route.handler)
          return () => {}
        },
      }
    }
    if (name === 'sessionPersistence') {
      return {
        stat: async (id) => {
          const head = persistedHeaders.get(id)
          if (head === undefined) throw new Error(`no such session ${id}`)
          return { header: head }
        },
      }
    }
    if (name === 'workspaceRegistry') {
      return {
        requireState: () => ({ archivedSessionIds: archivedIds }),
      }
    }
    if (name === 'connection') return { requestRejection: () => undefined }
    if (name === 'sessionController') {
      return {
        modelCatalog: async () => ({
          default: { provider: 'deepseek', model: 'deepseek-chat' },
          groups: [
            {
              id: 'deepseek',
              name: 'DeepSeek',
              models: [
                {
                  id: 'deepseek-chat',
                  name: 'DeepSeek Chat',
                  reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] },
                },
                { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
              ],
            },
          ],
          failures: [],
        }),
      }
    }
    if (name === 'attachments') {
      return {
        admitPromptContent: async (content) =>
          content.map((part, index) => ({ type: 'image', attachment: { mediaType: part.mediaType, name: part.name, bytes: 12, width: 2, height: 2, index } })),
      }
    }
    return undefined
  },
  on: (event, handler) => {
    handlers[event] = handler
    return () => {}
  },
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  logger: { info: () => {}, error: () => {} },
  systemPrompt: {
    section: (spec) => {
      sections.push(spec)
      return () => {}
    },
  },
}
const handlers = {}
const sections = []

/* ───────────────────────── fake req/res ───────────────────────── */

function post(method, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload ?? {}))
    const req = {
      method: 'POST',
      url: `/freedomchat/api/${method}`,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield body
      },
    }
    const res = {
      headersSent: false,
      status: 0,
      payload: undefined,
      writeHead(status) {
        this.status = status
        this.headersSent = true
      },
      end(text) {
        this.payload = JSON.parse(text)
        resolve(this)
      },
      destroy() {
        reject(new Error('response destroyed'))
      },
    }
    const handler = routeHandlers.at(-1)
    if (handler === undefined) {
      reject(new Error('no route handler registered yet'))
      return
    }
    handler(req, res).catch(reject)
  })
}

/* ───────────────────────── assertions ───────────────────────── */

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const value = (res) => {
  if (res.payload?.ok !== true) throw new Error(`call failed: ${JSON.stringify(res.payload)}`)
  return res.payload.value
}

/* ───────────────────────── scenario ───────────────────────── */

console.log('\n[0] project-folder encoding matches the host')
for (const [cwd, expected] of SEGMENT_CASES) {
  check(`segment ${cwd}`, encodeProjectSegment(cwd) === expected, {
    got: encodeProjectSegment(cwd),
    expected,
  })
}
check(
  'deleting a folder that does not exist reports false',
  (await deleteSessionArtifact('session-00000000-0000-0000-0000-000000000000', 'D:/DSH/work')) === false,
)

await apply(ctx)
check('route registered', typeof routeHandlers.at(-1) === 'function')

// 1. ensure creates a blank child bound to the parent
let res = await post('ensure', { parentSessionId: 'session-parent' })
const ensured = value(res)
const threadId = ensured.threadId
check('ensure returns a thread id', typeof threadId === 'string' && threadId.startsWith('session-'))
check('snapshot starts empty', Array.isArray(ensured.snapshot.messages) && ensured.snapshot.messages.length === 0, ensured.snapshot)

const createOptions = calls.find((call) => call[0] === 'agents.create')[1]
check('child is a subagent of the parent', createOptions.meta.parentSession === 'session-parent' && createOptions.meta.origin === 'subagent')
check('child inherits cwd', createOptions.meta.cwd === 'D:/DSH/work')
check('child is never seeded', createOptions.seed === undefined && createOptions.isSeeded === undefined && createOptions.inheritedEventCount === undefined)
check('child inherits the parent model route', createOptions.agentOptions.provider === 'deepseek' && createOptions.agentOptions.model === 'deepseek-chat', createOptions.agentOptions)

check('zero tools installed', restrictions.length === 1 && restrictions[0].deny.includes('ops_bash') && !restrictions[0].deny.includes('run_code'), restrictions)

// 2. ensure is idempotent for the same parent
const again = value(await post('ensure', { parentSessionId: 'session-parent' }))
check('ensure reuses the live thread', again.threadId === threadId)

// 3. unchanged version returns no messages
const version = ensured.snapshot.version
const idle = value(await post('snapshot', { threadId, version }))
check('unchanged version omits messages', idle.messages === undefined && idle.status === 'idle', idle)

// 4. send: accepted, thread running, live text streams
const sent = value(await post('send', { threadId, parts: [{ type: 'text', text: '你好' }] }))
check('send bumps the version', sent.version > version, sent)
const running = value(await post('snapshot', { threadId }))
check('thread reports running', running.status === 'running', running)
check('optimistic user row is already in the log', running.messages?.length === 1 && running.messages[0].role === 'user', running.messages)

handlers['agent/assistant-stream']({
  agent: threadsCreated[0],
  frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 },
})
handlers['agent/assistant-stream']({
  agent: threadsCreated[0],
  frame: { type: 'chunk', index: 0, time: Date.now(), chunk: { type: 'text-delta', text: '你' } },
})
handlers['agent/assistant-stream']({
  agent: threadsCreated[0],
  frame: { type: 'chunk', index: 1, time: Date.now(), chunk: { type: 'text-delta', text: '好' } },
})
const streaming = value(await post('snapshot', { threadId }))
check('live text reaches the client', streaming.live === '你好', streaming.live)

// 5. final assistant message lands in the log, live buffer clears
threadsCreated[0].session.snapshotEvents().push({
  type: 'assistant/message',
  time: new Date().toISOString(),
  data: {
    turn: 1,
    step: 1,
    message: { id: 'msg-a1', role: 'assistant', content: [{ type: 'text', text: '你好，我在。' }], source: { kind: 'model' } },
  },
})
handlers['agent/assistant-stream']({ agent: threadsCreated[0], frame: { type: 'end', attemptId: 'a1', outcome: { kind: 'committed' } } })
threadsCreated[0].status = 'idle'
const finished = value(await post('snapshot', { threadId }))
check('assistant row folded from the log', finished.messages?.length === 2 && finished.messages[1].role === 'assistant', finished.messages)
check('live buffer cleared at end', finished.live === undefined)

// 6. sending while running is rejected
threadsCreated[0].status = 'running'
const busy = await post('send', { threadId, parts: [{ type: 'text', text: '再来' }] })
check('busy send rejected', busy.status === 409 && busy.payload.error.code === 'busy', busy.payload)
threadsCreated[0].status = 'idle'

// 7. image parts go through the attachments service
const withImage = value(
  await post('send', {
    threadId,
    parts: [
      { type: 'text', text: '看图' },
      { type: 'image', mediaType: 'image/png', name: 'a.png', data: 'AAAA' },
    ],
  }),
)
check('image send accepted', typeof withImage.messageId === 'string')
const lastUser = threadsCreated[0].session.snapshotEvents().at(-1)
check('image block admitted', lastUser.data.content.some((block) => block.type === 'image'))

// 8. cancel stops the turn
await post('cancel', { threadId })
check('cancel returned', threadsCreated[0].status === 'idle')

// 8b. put a real folder where the host would keep this thread's transcript, so
// the clear assertion below proves a deletion instead of a missing path. The
// previous version of this test never created the folder, so `!existsSync`
// passed even while the encoder pointed at the wrong place.
const threadDir = sessionDirOf(threadId, 'D:/DSH/work')
await mkdir(threadDir, { recursive: true })
await writeFile(join(threadDir, 'session.v4.jsonl.zstd'), 'x')
check('the stubbed transcript exists before clear', existsSync(threadDir), threadDir)

// 9. clear deletes this side conversation; nothing is minted until the next message
const cleared = value(await post('clear', { threadId }))
check('clear answers with an empty panel', cleared.state === 'empty' && cleared.threadId === null, cleared)
check('old agent disposed', threadsCreated[0].status === 'disposed')
check(
  'clear also deletes the old transcript',
  !existsSync(sessionDirOf(threadId, 'D:/DSH/work')),
  sessionDirOf(threadId, 'D:/DSH/work'),
)
const afterClearPeek = value(await post('peek', { parentSessionId: 'session-parent' }))
check('peek after clear reports empty', afterClearPeek.state === 'empty', afterClearPeek)
check('peek after clear created nothing', threadsCreated.length === 1, threadsCreated.length)

const clearedAgain = value(await post('ensure', { parentSessionId: 'session-parent' }))
check('the next message mints a fresh thread', clearedAgain.state === 'live' && clearedAgain.threadId !== threadId)

// 10. unknown method and unknown thread
const unknown = await post('nope', {})
check('unknown method answers 404', unknown.status === 404 && unknown.payload.ok === false)
const missing = await post('snapshot', { threadId: 'session-does-not-exist' })
check('unknown thread answers 404', missing.status === 404)

// 11. GET is refused
const getRes = await new Promise((resolve) => {
  const req = { method: 'GET', url: '/freedomchat/api/ensure', headers: {}, async *[Symbol.asyncIterator]() {} }
  const res = {
    headersSent: false,
    writeHead(status) { this.status = status },
    end(text) { this.payload = JSON.parse(text); resolve(this) },
    destroy() {},
  }
  routeHandlers.at(-1)(req, res)
})
check('GET refused', getRes.status === 405, getRes.status)

// 12. the hard gate refuses tools for our threads and only ours
let nextCalled = 0
const denied = await handlers['tools/pre-execute']({ agent: threadsCreated[1], name: 'ops_bash' }, () => {
  nextCalled += 1
})
check('side-thread tool call denied', denied?.kind === 'deny', denied)
const foreign = await handlers['tools/pre-execute']({ agent: parent, name: 'read_file' }, () => {
  nextCalled += 1
})
check('main-session tool call passes through', foreign === undefined && nextCalled === 1, { foreign, nextCalled })

// 13. standing instructions apply to our agents only
const section = sections.find((entry) => entry.name === 'freedomchat:side-thread')
check('prompt section registered', section !== undefined)
check(
  'side thread receives the standing instructions',
  section?.text({ agent: threadsCreated[1] }).includes('没有本地执行权限'),
  section?.text({ agent: threadsCreated[1] }),
)
check('other sessions receive nothing', section?.text({ agent: parent }) === '', section?.text({ agent: parent }))

// 14. panel switches: parent read tool, intent gate, tri-state, web switch
const baseThread = clearedAgain.threadId
const freshAgent = threadsCreated.at(-1)
freshAgent.session.snapshotEvents().push({
  type: 'user/message',
  time: new Date().toISOString(),
  data: { id: 'side-1', role: 'user', content: [{ type: 'text', text: '我们在讨论数据库选型' }] },
})

const snap0 = value(await post('snapshot', { threadId: baseThread }))
check(
  'switches default to closed / deny',
  snap0.settings?.open === false && snap0.settings?.mainRead === false && snap0.settings?.sideRead === 'deny' && snap0.settings?.web === false,
  snap0.settings,
)

const opened = value(await post('setSettings', { threadId: baseThread, patch: { open: true, mainRead: true } }))
check('panel open + switch on attaches the main read tool', parent.registrations.has('read_freedom_chat'), [...parent.registrations.keys()])
check('setSettings echoes the new state', opened.settings.open === true && opened.settings.mainRead === true, opened.settings)

parentEvents.push({
  type: 'user/message',
  time: new Date().toISOString(),
  data: { id: 'p1', role: 'user', content: [{ type: 'text', text: '列出当前目录' }] },
})
const refused = await parent.registrations.get('read_freedom_chat').execute({}, { agent: parent })
check('reading without an explicit ask is refused', typeof refused?.text === 'string' && refused.text.includes('拒绝'), refused)

parentEvents.push({
  type: 'user/message',
  time: new Date().toISOString(),
  data: { id: 'p2', role: 'user', content: [{ type: 'text', text: '读一下侧边对话' }] },
})
const read = await parent.registrations.get('read_freedom_chat').execute({}, { agent: parent })
check('an explicit ask returns the side transcript', typeof read?.text === 'string' && read.text.includes('数据库选型'), read)

// The host injects time-context / runtime-context rows as user/message too; a
// row like that lands *after* the typed prompt and must not shadow it.
parentEvents.push({
  type: 'user/message',
  time: new Date().toISOString(),
  data: {
    id: 'p3',
    role: 'user',
    source: { kind: 'time-context', form: 'snapshot' },
    content: [{ type: 'text', text: 'Time sampled while preparing turn 2, step 1' }],
  },
})
const stillRead = await parent.registrations.get('read_freedom_chat').execute({}, { agent: parent })
check(
  'injected time-context does not shadow the typed ask',
  typeof stillRead?.text === 'string' && stillRead.text.includes('数据库选型'),
  stillRead,
)

await post('setSettings', { threadId: baseThread, patch: { sideRead: 'deny' } })
check('side read tool stays absent while denied', freshAgent.registrations.has('read_main_conversation') === false)

await post('setSettings', { threadId: baseThread, patch: { sideRead: 'allow' } })
check('side read tool attaches when allowed', freshAgent.registrations.has('read_main_conversation'))
const mainTranscript = await freshAgent.registrations.get('read_main_conversation').execute({}, { agent: freshAgent })
check('side reads the main transcript when allowed', mainTranscript?.text?.includes('列出当前目录') === true, mainTranscript)

await post('setSettings', { threadId: baseThread, patch: { sideRead: 'ask' } })
const pendingAllow = freshAgent.registrations.get('read_main_conversation').execute({}, { agent: freshAgent })
await new Promise((resolve) => setTimeout(resolve, 20))
const asked = value(await post('snapshot', { threadId: baseThread }))
check('ask surfaces a pending approval', typeof asked.approval?.id === 'string', asked.approval)
value(await post('resolveApproval', { threadId: baseThread, approvalId: asked.approval.id, allow: true }))
const approved = await pendingAllow
check('approval lets the read through', approved?.text?.includes('列出当前目录') === true, approved)

const pendingDeny = freshAgent.registrations.get('read_main_conversation').execute({}, { agent: freshAgent })
await new Promise((resolve) => setTimeout(resolve, 20))
const askedAgain = value(await post('snapshot', { threadId: baseThread }))
value(await post('resolveApproval', { threadId: baseThread, approvalId: askedAgain.approval.id, allow: false }))
const deniedRead = await pendingDeny
check('denial blocks the read', deniedRead?.text?.includes('没有允许') === true, deniedRead)

await post('setSettings', { threadId: baseThread, patch: { web: true } })
const lastRestriction = restrictions.at(-1)
check(
  'web switch narrows the scope to the web tools only',
  Array.isArray(lastRestriction?.allow) && lastRestriction.allow.includes('web_search') && !lastRestriction.allow.includes('ops_bash'),
  lastRestriction,
)
const webAllowed = await handlers['tools/pre-execute']({ agent: freshAgent, name: 'web_search' }, () => {})
check('web tool allowed while the switch is on', webAllowed === undefined, webAllowed)
const bashDenied = await handlers['tools/pre-execute']({ agent: freshAgent, name: 'ops_bash' }, () => {})
check('bash still denied while web is on', bashDenied?.kind === 'deny', bashDenied)
check('prompt mentions the web grant', section.text({ agent: freshAgent }).includes('联网工具已开启'))

await post('setSettings', { threadId: baseThread, patch: { open: false } })
check('closing the panel removes the main read tool', parent.registrations.has('read_freedom_chat') === false)

// 15. two concurrent ensures mint exactly one child (React strict mode mounts twice)
const before = threadsCreated.length
const [first, second] = await Promise.all([
  post('ensure', { parentSessionId: 'session-parent' }),
  post('ensure', { parentSessionId: 'session-parent' }),
])
check(
  'concurrent ensure shares one thread',
  value(first).threadId === value(second).threadId && threadsCreated.length === before,
  { first: value(first).threadId, second: value(second).threadId, created: threadsCreated.length - before },
)

// 16. model catalog + picker writes
const catalog = await post('catalog', {})
check(
  'catalog mirrors the host groups',
  value(catalog).available === true && value(catalog).groups?.[0]?.models?.length === 2,
  value(catalog),
)
const picked = await post('setModel', {
  threadId: baseThread,
  provider: 'deepseek',
  model: 'deepseek-reasoner',
})
check(
  'setModel applies the route and reports it back',
  value(picked).model?.id === 'deepseek-reasoner' && value(picked).model?.provider === 'deepseek',
  value(picked).model,
)
check(
  'setModel recorded a model/selection on the agent',
  selections.at(-1)?.next?.model === 'deepseek-reasoner',
  selections.at(-1),
)
const effort = await post('setModel', {
  threadId: baseThread,
  provider: 'deepseek',
  model: 'deepseek-reasoner',
  reasoningEffort: 'high',
})
check('setModel keeps the reasoning effort', value(effort).model?.reasoningEffort === 'high', value(effort).model)
const badModel = await post('setModel', { threadId: baseThread, provider: '', model: '' })
check('setModel rejects an empty route', badModel.status === 400, badModel.status)

// 17. the mapping is durable, and a restart cold-resumes it
/* ── two windows racing to create the same side thread ─────────────── */
const { putEntry } = await import('../lib/state.js')
const raceParent = 'session-parent-race'
const raceWinner = 'session-winner'
persistedHeaders.set(raceWinner, { id: raceWinner, cwd: 'D:/DSH/work', origin: 'subagent' })
onBeforeCreate = async () => {
  // Another window wins the registry write while our create is in flight.
  await putEntry(raceParent, {
    threadId: raceWinner,
    state: 'live',
    cwd: 'D:/DSH/work',
    settings: { open: false, mainRead: false, sideRead: 'deny', web: false },
    createdAt: Date.now(),
  })
}
const raced = await post('ensure', { parentSessionId: raceParent })
const raceLoser = threadsCreated[threadsCreated.length - 1]
check('a create race yields the winner thread', value(raced).threadId === raceWinner, value(raced))
check('the losing thread is disposed', raceLoser?.status === 'disposed', raceLoser?.status)
check(
  'the losing transcript is deleted',
  raceLoser?.id !== undefined && !existsSync(sessionDirOf(raceLoser.id, 'D:/DSH/work')),
  raceLoser?.id,
)

const registryText = await readFile(registryFile, 'utf8')
const registry = JSON.parse(registryText)
check(
  'registry remembers parent -> thread',
  registry.threads?.['session-parent']?.threadId === baseThread,
  registry.threads?.['session-parent'],
)
check(
  'registry keeps the switches',
  registry.threads?.['session-parent']?.settings?.mainRead === true,
  registry.threads?.['session-parent']?.settings,
)

check(
  'registry remembers the route chosen in the panel',
  registry.threads?.['session-parent']?.model?.model === 'deepseek-reasoner' &&
    registry.threads?.['session-parent']?.model?.reasoningEffort === 'high',
  registry.threads?.['session-parent']?.model,
)

persistedHeaders.set(baseThread, { id: baseThread, cwd: 'D:/DSH/work', origin: 'subagent' })
stripResumedModel = true
const { apply: applyAfterRestart } = await import('../lib/index.js?restart=1')
await applyAfterRestart(ctx)
const resumed = await post('ensure', { parentSessionId: 'session-parent' })
check(
  'cold resume reuses the persisted thread',
  value(resumed).threadId === baseThread && value(resumed).state === 'live',
  value(resumed).threadId,
)
check(
  'cold resume went through agents.resume',
  calls.some((entry) => entry[0] === 'agents.resume' && entry[1]?.resumeSessionId === baseThread),
  calls.filter((entry) => entry[0] === 'agents.resume').length,
)
check(
  'a resumed thread without a reported model still shows one',
  typeof value(resumed).snapshot?.model?.id === 'string' &&
    value(resumed).snapshot.model.id !== '' &&
    typeof value(resumed).snapshot?.model?.provider === 'string',
  value(resumed).snapshot?.model,
)
check(
  'a resumed thread does not inherit the parent history',
  Array.isArray(value(resumed).snapshot?.messages) && value(resumed).snapshot.messages.length === 0,
  value(resumed).snapshot?.messages?.length,
)

// 18. archiving the main session deletes its side thread
archivedIds.push('session-parent')
const afterArchive = await post('ensure', { parentSessionId: 'session-parent' })
check(
  'archived main session answers with a tombstone',
  value(afterArchive).state === 'archived' && value(afterArchive).threadId === null,
  value(afterArchive),
)
const tomb = JSON.parse(await readFile(registryFile, 'utf8')).threads?.['session-parent']
check('tombstone has no thread id', tomb?.threadId === null && tomb?.state === 'archived', tomb)

// 18b. a poll that races the sweep gets the tombstone, not a bare 404
const stalePoll = await post('snapshot', { threadId: baseThread })
check(
  'polling a retired thread answers the tombstone',
  value(stalePoll).state === 'archived' && value(stalePoll).threadId === null,
  value(stalePoll),
)

// 18c. unarchiving the main session must bring back an EMPTY chat
archivedIds.length = 0
const afterUnarchive = await post('ensure', { parentSessionId: 'session-parent' })
check(
  'unarchive revives a fresh empty thread',
  value(afterUnarchive).state === 'live' && value(afterUnarchive).threadId !== baseThread,
  { state: value(afterUnarchive).state, threadId: value(afterUnarchive).threadId },
)
check(
  'the revived thread starts empty',
  Array.isArray(value(afterUnarchive).snapshot?.messages) && value(afterUnarchive).snapshot.messages.length === 0,
  value(afterUnarchive).snapshot?.messages?.length,
)

// 19. revive starts a new thread from the tombstone
const revived = await post('revive', { parentSessionId: 'session-parent' })
const revivedId = value(revived).threadId
check(
  'revive mints a fresh thread',
  typeof revivedId === 'string' && revivedId !== baseThread && value(revived).state === 'live',
  revivedId,
)
const revivedEntry = JSON.parse(await readFile(registryFile, 'utf8')).threads?.['session-parent']
check('revive clears the tombstone', revivedEntry?.threadId === revivedId && revivedEntry?.state === 'live', revivedEntry)

// 20. deleting the main session retires the thread through the sweep
persistedHeaders.delete('session-parent')
const { apply: applyAfterSecondRestart } = await import('../lib/index.js?restart=2')
await applyAfterSecondRestart(ctx)
const afterDelete = await post('ensure', { parentSessionId: 'session-parent' })
check(
  'deleted main session answers with a tombstone',
  value(afterDelete).state === 'archived' && value(afterDelete).threadId === null,
  value(afterDelete),
)
const revivedDir = sessionDirOf(revivedId, 'D:/DSH/work')
check(
  'the retired thread artifact is gone',
  !existsSync(revivedDir),
  revivedDir,
)

await rm(sandbox, { recursive: true, force: true })

console.log(failures === 0 ? '\nhost smoke OK' : `\nhost smoke FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

const silent = value(await post('ensure', { parentSessionId: 'session-parent-silent' }))
check(
  'a fresh panel falls back to the catalog default instead of "未知"',
  silent.snapshot?.model?.id === 'deepseek-chat' && silent.snapshot?.model?.provider === 'deepseek',
  silent.snapshot?.model,
)
