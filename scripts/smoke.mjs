/**
 * P0 smoke test: load the client half the way the host's module loader does,
 * then run its apply() against a fake client context. No browser, no app.
 *
 *   node scripts/smoke.mjs
 */
const calls = []
let loaded = null

function Component() {}
Component.prototype = {}
Component.getDerivedStateFromError = null

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Component,
}

globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
      loaded.exports = definition.factory((name) => {
        if (name === 'react') return react
        throw new Error('unexpected require: ' + name)
      })
    },
  },
}

await import('../lib/client.js')

if (!loaded) throw new Error('client half never called __ModuleLoader__.load')
if (loaded.id !== 'dsh-freedomchat') throw new Error('unexpected loader id: ' + loaded.id)
if (typeof loaded.exports.apply !== 'function') throw new Error('missing apply export')
if (!Array.isArray(loaded.exports.inject)) throw new Error('missing inject export')

const ctx = {
  get: (name) => {
    calls.push(['get', name])
    if (name === 'sidebarRightTabs') {
      return {
        register: (descriptor) => {
          calls.push(['tab.register', descriptor])
          return () => calls.push(['tab.dispose'])
        },
      }
    }
    return undefined
  },
  slots: {
    inject: (name, factory) => {
      calls.push(['slots.inject', name])
      return factory()
    },
    register: (options, component) => {
      calls.push(['slots.register', options, component])
      return () => calls.push(['slot.dispose'])
    },
  },
}

const dispose = loaded.exports.apply(ctx)

const tab = calls.find((call) => call[0] === 'tab.register')
if (!tab) throw new Error('no tab type registered')
if (tab[1].id !== 'dsh-freedomchat' || tab[1].kind !== 'dsh-freedomchat') {
  throw new Error('tab id/kind mismatch: ' + JSON.stringify(tab[1].id) + '/' + JSON.stringify(tab[1].kind))
}
if (typeof tab[1].title() !== 'string') throw new Error('tab title is not a string')
if (!Array.isArray(tab[1].guide) || tab[1].guide.length === 0) throw new Error('no guide entry')
if (typeof tab[1].guide[0].title() !== 'string') throw new Error('guide title is not a string')
if (tab[1].guide[0].title() !== '侧边自由对话') throw new Error('guide title must be the plain label')
if (typeof tab[1].guide[0].icon !== 'function') throw new Error('guide entry must carry an icon')
const guideGlyph = JSON.stringify(tab[1].guide[0].icon({ size: 16 }))
if (!guideGlyph.includes('svg')) throw new Error('guide icon is not an svg')

// The rail draws the tab glyph; it must be the same mark the beta side chat
// uses, handed over as a size -> element function.
if (typeof tab[1].icon !== 'function') throw new Error('tab icon missing')
const glyph = tab[1].icon(16)
const flatGlyph = JSON.stringify(glyph)
if (!flatGlyph.includes('svg') || !flatGlyph.includes('viewBox')) {
  throw new Error('tab icon is not an svg: ' + flatGlyph.slice(0, 120))
}
if (typeof tab[1].icon(14) !== 'object') throw new Error('tab icon must accept a size')


const slot = calls.find((call) => call[0] === 'slots.register')
if (!slot) throw new Error('no pane slot registered')
if (slot[1].name !== 'sidebar.right.pane.tab') throw new Error('wrong slot name: ' + slot[1].name)
if (slot[1].key !== 'dsh-freedomchat') throw new Error('slot key must equal tab id, got ' + slot[1].key)
if (typeof slot[2] !== 'function') throw new Error('pane body is not a component')

// The host strip draws the chip from `title` text alone (its tab record has no
// icon field), so the glyph is part of the title string.
const tabTitle = tab[1].title()
if (!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(tabTitle)) throw new Error('tab title carries no glyph: ' + tabTitle)
if (!tabTitle.includes('侧边自由对话')) throw new Error('tab title lost its label: ' + tabTitle)
if (calls.some((call) => call[0] === 'slots.register' && call[1].name === 'sidebar.right.pane.tab.title')) {
  throw new Error('title slot must not be registered: the host ignores it for extension tabs')
}

// The injected props must carry the current session id.
const props = slot[1].inject('session-abc')
if (props.sessionId !== 'session-abc') throw new Error('inject() did not forward sessionId')

// Render the body once with the fake createElement; a crash here would blank the tab.
const tree = slot[2](props)
if (!tree) throw new Error('panel rendered nothing')

if (typeof dispose !== 'function') throw new Error('apply() must return a disposer')
dispose()

console.log('smoke OK — tab:', tab[1].title(), '| guide:', tab[1].guide[0].title())
const disposed = calls.filter((call) => String(call[0]).endsWith('dispose')).length
if (disposed !== 2) throw new Error('unexpected dispose count: ' + disposed)
console.log('dispose calls:', disposed)
const slots = calls.filter((call) => call[0] === 'slots.register').map((call) => call[1].name)
console.log('slots:', slots.join(', '))