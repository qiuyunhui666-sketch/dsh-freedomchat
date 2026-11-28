# Changelog

## 0.1.2

### Fixed

- **Images larger than ~780 KB no longer fail with "request body too large".**
  The panel accepted pictures up to 8 MB, but the host read the whole request
  through a 1 MB cap; base64 inflates by 4/3, so most screenshots and every
  phone photo were rejected with a 413 before reaching the model. The request
  cap is now 32 MB, and the panel refuses a selection whose raw total exceeds
  18 MB (≈24 MB once encoded) with a clear message.

- **Two windows pressing 「新建对话」 at once can no longer mint two side
  threads.** `api.revive` now shares the same single-flight map as `api.ensure`,
  so a double click or a second window gets the first thread instead of leaving
  an orphan.

- **A create race no longer leaves the registry pointing at a disposed
  thread.** If the winning thread could not be resumed, the losing thread was
  already gone and the old code still wrote its id into `threads.json`; it now
  answers 503 and lets the next `ensure` build a clean thread.

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