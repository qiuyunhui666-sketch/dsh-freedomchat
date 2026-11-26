# Changelog

## 0.1.1

### Fixed

- **Deleted side conversations actually leave the disk.** DSH names a project's
  session folder by encoding its cwd: `:` `\` and `/` each become `-` and runs
  of `-` collapse into one, so `D:\DSH\work` is `--D-DSH-work--`. The plugin
  turned each separator into its own `-` and looked for `--D--DSH-work--`
  instead. `rm(path, { force: true })` reports success for a path that does not
  exist, so every delete path — 清空, the archive sweep, and the create race —
  reported success while leaving the transcript behind. Those leftovers showed
  up as extra 子智能体会话 under the main conversation: one long session had
  accumulated eight of them.

- `deleteSessionArtifact` now stats the folder first and returns `false` when
  there is nothing there, so a silent no-op can no longer masquerade as a
  deletion. `清空` and the archive sweep log `artifactDeleted=` accordingly.

### Added

- `scripts/cleanup-orphans.mjs` recognises a server-side record of every thread
  id the plugin ever minted (`.dsh/freedomchat/threads.json` → `created`), so a
  transcript whose delete failed is still attributable after the mapping was
  dropped. The ledger is capped at 300 entries.

- The host smoke test asserts the project-folder encoding against eleven real
  folder names this machine produced, and now builds a real transcript folder
  before asserting that `clear` removes it. Reverting the encoder to the old
  behaviour fails thirteen checks instead of passing silently.