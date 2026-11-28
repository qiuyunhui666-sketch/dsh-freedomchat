/**
 * Dev installer: copy this plugin into the desktop profile and make sure the
 * profile's bundle list references it. Idempotent — safe to re-run after every
 * edit while iterating.
 *
 *   node scripts/install-dev.mjs
 *
 * Restart DeepSeek Harness afterwards: the host reads the bundle list at start.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '..')
const profile =
  process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')
const profilePackage = join(profile, 'package.json')
const target = join(profile, 'node_modules', 'dsh-freedomchat')

if (!existsSync(profilePackage)) {
  console.error('profile package.json not found:', profilePackage)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const name = manifest.name

rmSync(target, { recursive: true, force: true })
cpSync(source, target, {
  recursive: true,
  filter: (from) => !from.includes(`${join('', 'node_modules')}`) && !from.endsWith('.git'),
})

const pkg = JSON.parse(readFileSync(profilePackage, 'utf8'))
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
const bundles = pkg.dsh.profile.bundles

if (bundles.includes(name)) {
  console.log('bundle already enabled:', name)
} else {
  bundles.push(name)
  writeFileSync(profilePackage, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log('bundle enabled:', name)
}

console.log('installed to:', target)
console.log('bundles:', bundles.length)
console.log('\nNow restart DeepSeek Harness, then check the right sidebar for', name)