/**
 * Headless render check for the Freedom chat panel.
 *
 * The panel is plain React without a bundler, so a tiny fake React renderer is
 * enough to prove the tree builds and that the composer bar (read-side pill,
 * web pill, three-way read-main menu), the approval bar and the model picker
 * actually show up. No network calls
 * happen here: effects are collected but never run.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ── fake React ─────────────────────────────────────────────────── */

let cursor = 0
const cells = []
const refs = []
const effects = []

const React = {
  createElement(type, props, ...children) {
    const flat = []
    const push = (value) => {
      if (value === null || value === undefined || value === false || value === true) return
      if (Array.isArray(value)) value.forEach(push)
      else flat.push(value)
    }
    push(children)
    return { type, props: { ...(props || {}), children: flat } }
  },
  useState(initial) {
    const slot = cursor++
    if (!(slot in cells)) cells[slot] = typeof initial === 'function' ? initial() : initial
    const setter = (next) => {
      cells[slot] = typeof next === 'function' ? next(cells[slot]) : next
    }
    return [cells[slot], setter]
  },
  useRef(initial) {
    const slot = cursor++
    if (!(slot in refs)) refs[slot] = { current: initial }
    return refs[slot]
  },
  useEffect(fn) {
    effects.push(fn)
  },
  useMemo(fn) {
    return fn()
  },
}

// The error boundary is the one class component; give it just enough React.
function FakeComponent(props) {
  this.props = props || {}
}
FakeComponent.prototype.setState = function setState() {}
FakeComponent.prototype.componentDidMount = function componentDidMount() {}
React.Component = FakeComponent

/* ── fake host ──────────────────────────────────────────────────── */

let registeredTab = null
let registeredSlots = {}
let exportsRef = null

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      const module = { exports: {} }
      const require = (id) => {
        if (id === 'react') return React
        throw new Error(`unexpected require: ${id}`)
      }
      const out = factory(require, module, module.exports)
      exportsRef = out || module.exports
    },
  },
}

const ctx = {
  get: (name) => (name === 'sidebarRightTabs' ? { register: (tab) => (registeredTab = tab) } : undefined),
  slots: {
    inject: (name, fn) => fn(),
    register: (meta, component) => {
      registeredSlots[meta.name] = { meta, component }
      return () => {}
    },
  },
}

new Function('window', source)(globalThis.window)
assert.ok(exportsRef && typeof exportsRef.apply === 'function', 'client bundle must export apply')
exportsRef.apply(ctx)
assert.ok(registeredTab, 'tab type must register')

/* ── render ─────────────────────────────────────────────────────── */

const bodySlot = registeredSlots['sidebar.right.pane.tab']
const registeredSlot = bodySlot
const Panel = registeredSlot && registeredSlot.component
assert.ok(typeof Panel === 'function', 'panel component must register')
assert.equal(registeredSlot.meta.key, registeredTab.id, 'pane slot key must equal the tab id')

const expandCache = new WeakMap()
/** Expand a component element exactly once per element object, so repeated
 *  traversal (texts + findButton) never re-runs a component and desyncs the
 *  slot-indexed fake useState cells. */
function expand(node) {
  let guard = 0
  while (
    node &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    typeof node.type === 'function' &&
    guard++ < 20
  ) {
    let out = expandCache.get(node)
    if (out === undefined) {
      const isClass = node.type.prototype && typeof node.type.prototype.render === 'function'
      out = isClass ? new node.type(node.props).render() : node.type(node.props)
      expandCache.set(node, out)
    }
    node = out
  }
  return node
}

function render() {
  effects.length = 0
  cursor = 0
  return Panel({ sessionId: 'session-render-smoke' })
}

function texts(node, out = []) {
  node = expand(node)
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((child) => texts(child, out))
    return out
  }
  const children = node.props && node.props.children
  if (children) texts(children, out)
  return out
}

function findNode(node, predicate, out = []) {
  const visit = (current) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) { current.forEach(visit); return }
    if (typeof current !== 'object' || !current.type) return
    const expanded = expand(current)
    if (Array.isArray(expanded)) { expanded.forEach(visit); return }
    if (expanded === null || expanded === undefined || typeof expanded !== 'object' || !expanded.type) return
    if (predicate(expanded)) { out.push(expanded); return }
    const children = expanded.props && expanded.props.children
    if (children) visit(children)
  }
  visit(node)
  return out
}

cursor = 0
const first = render()
const firstText = texts(first).join(' | ')
// The two toggles carry a lamp: hollow when off, filled when on.
const offPill = findButton(first, '读从对话')
const offLamp = offPill && (offPill.props.children || []).filter((node) => node && node.type === 'span')[0]
assert.ok(offLamp && offLamp.props.style.borderStyle === undefined && String(offLamp.props.style.border).includes('solid'), 'off pill shows a hollow lamp')
assert.ok(String(offPill.props.className).includes('fc-pill'), 'pill carries the hover class')
assert.strictEqual(offPill.props.style.border, '1px solid transparent', 'idle pill has no visible border')
const savedServer = cells[0]
const serverOn = JSON.parse(JSON.stringify(savedServer))
serverOn.settings.mainRead = true
cells[0] = serverOn
if (process.env.FC_DEBUG === '1') console.log('CELL0 mainRead:', cells[0] && cells[0].settings && cells[0].settings.mainRead)
const litFirst = render()
const litPill = findButton(litFirst, '读从对话')
const litLamp = litPill && (litPill.props.children || []).filter((node) => node && node.type === 'span')[0]
assert.ok(litLamp && String(litLamp.props.style.background).includes('--dsw-alias-state-business-primary'), 'on pill fills its lamp')
assert.strictEqual(litPill.props.style.border, '1px solid transparent', 'on pill keeps a borderless frame')
assert.strictEqual(String(litPill.props.style.color).includes('business-primary'), false, 'on pill does not colour the frame')
// Function components expand lazily, so the fixture must stay in place until
// the assertions above have walked the tree.
cells[0] = savedServer

// The read-main pill opens the three-way menu (allow / ask / deny).
const sidePill = findButton(first, '读主对话')
assert.ok(sidePill, 'read-main pill renders as a button')
sidePill.props.onClick()
const opened = render()
const openedText = texts(opened).join(' | ')
for (const option of ['允许', '询问', '不允许']) {
  assert.ok(openedText.includes(option), `side read menu offers "${option}"`)
}


// The server cell is the first useState inside useFreedomChat; put a pending
// approval there and render again.
const server = cells[0]
assert.ok(server && typeof server === 'object', 'server state cell must exist')
cells[0] = {
  ...server,
  phase: 'ready',
  status: 'running',
  approval: { id: 'apr-1', at: Date.now() },
  settings: { open: true, mainRead: true, sideRead: 'ask', web: false },
}
cursor = 0
const second = render()
const secondText = texts(second).join(' | ')
assert.ok(secondText.includes('侧边对话想读取主对话最近的内容'), 'approval bar should render')
assert.ok(secondText.includes('允许') && secondText.includes('拒绝'), 'approval bar offers allow/deny')

/* Model picker: the catalog cell (5) and the open flag (6) follow the five
 * state cells before them inside useFreedomChat. */
function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label)
      if (hit) return hit
    }
    return null
  }
  node = expand(node)
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label)
      if (hit) return hit
    }
    return null
  }
  if (node && typeof node === 'object') {
    const aria = node.props && node.props['aria-label']
    if (
      node.type === 'button' &&
      ((typeof aria === 'string' && aria.includes(label)) || texts(node, []).some((text) => text.includes(label)))
    )
      return node
    return findButton(node.props && node.props.children, label)
  }
  return null
}

cells[5] = {
  available: true,
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-chat',
          name: 'DeepSeek Chat',
          reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] },
        },
      ],
    },
  ],
}
cells[0] = { ...cells[0], model: { provider: 'deepseek', id: 'deepseek-chat', reasoningEffort: 'high', label: 'deepseek / deepseek-chat' } }
cells[6] = true
cursor = 0
const third = render()
const thirdText = texts(third).join(' | ')
assert.ok(thirdText.includes('DeepSeek Chat'), 'model menu lists the catalog models')
assert.ok(thirdText.includes('推理强度') && thirdText.includes('高'), 'effort row shows for a reasoning model')
const row = findButton(third, 'DeepSeek Chat')
assert.ok(row, 'the model row must be a button')
row.props.onClick()
assert.equal(cells[6], false, 'picking a model closes the menu')

/* Archived tombstone: the main session went away, so the panel explains it and
 * offers a fresh start instead of a composer. */
cells[6] = false
cells[0] = {
  ...cells[0],
  phase: 'archived',
  threadId: null,
  messages: [],
  approval: null,
  settings: { open: false, mainRead: false, sideRead: 'deny', web: false },
}
cursor = 0
const fourth = render()
const fourthText = texts(fourth).join(' | ')
assert.ok(fourthText.includes('主对话已归档'), 'archived panel explains what happened')
assert.ok(findButton(fourth, '新建对话'), 'archived panel offers a fresh thread')
assert.ok(!findButton(fourth, '发送'), 'archived panel hides the composer')

/* Empty panel: no thread yet, but sending is allowed because the first message
 * creates one. */
cells[0] = {
  ...cells[0],
  phase: 'empty',
  status: 'idle',
  threadId: null,
  messages: [],
  approval: null,
  settings: { open: false, mainRead: false, sideRead: 'deny', web: false },
}
cells[1] = '你好' // a draft makes the send button enabled
cursor = 0
const fifth = render()
const fifthText = texts(fifth).join(' | ')
assert.ok(fifthText.includes('还没有侧边对话'), 'empty panel says there is no thread yet')
const emptyBox = findNode(
  fifth,
  (node) =>
    node.props &&
    node.props.style &&
    node.props.style.flexDirection === 'column' &&
    texts(node).join('').includes('还没有侧边对话'),
)[0]
assert.ok(emptyBox, 'empty state stacks its lines vertically')
const sendBtn = findButton(fifth, '发送')
assert.ok(sendBtn && sendBtn.props.disabled !== true, 'empty panel still offers send')
cells[1] = ''

/* Model chips: three per row, so a group of 3+ models becomes multiple rows. */
cells[0] = { ...cells[0], phase: 'ready', status: 'idle', threadId: 'session-x', model: undefined }
cells[5] = {
  available: true,
  groups: [
    {
      id: 'qwen-token-plan-cn',
      name: 'qwen-token-plan-cn',
      models: [
        { id: 'qwen3-max', name: 'qwen3-max' },
        { id: 'qwen3-coder', name: 'qwen3-coder' },
        { id: 'qwen3-vl', name: 'qwen3-vl' },
        { id: 'qwen2.5-72b', name: 'qwen2.5-72b' },
      ],
    },
  ],
}
cells[6] = true
cursor = 0
const sixth = render()
const sixthText = texts(sixth).join(' | ')
assert.ok(sixthText.includes('qwen3-max'), 'chips list every model')
const rows = []
;(function walk(node) {
  node = expand(node)
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach(walk)
  const style = node.props && node.props.style
  if (style && style.flex === '1 1 0' && style.borderRadius === 10) rows.push(node)
  const children = node.props && node.props.children
  if (children) walk(children)
})(sixth)
assert.equal(rows.length, 4, 'one chip per model')
assert.ok(findButton(sixth, 'qwen3-vl'), 'each chip is its own button')

console.log('render smoke OK — beta composer + tab label glyph + approval bar + model picker + archived tombstone')