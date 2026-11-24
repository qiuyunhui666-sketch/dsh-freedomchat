# Side Freedom Chat

**A chat-only panel in the right sidebar of every session — talk, don't touch.**

Your main session is busy running a task. You want to ask a quick question, think something through, or have another model look at the same problem — without dumping that chatter into the main context, and without giving it the keys to your machine.

That is exactly what this plugin is: a conversation window **isolated from the main session**. Its own model, its own history, its own switches, and nothing reachable by default.

## How it differs from the built-in Side chat (beta)

| | Side Freedom Chat | Side chat (beta) |
| --- | --- | --- |
| Context | Starts empty, **inherits nothing** | Inherits the main session's full history |
| Tools | **No local execution**, enforced by the host | Follows the parent preset, can run tools |
| Model | Per panel, defaults to the main session's | Inherited |
| Clear | Deletes the thread and its transcript | Starts a new thread |
| Archive | Deleted together with the archived session | Archiving is disabled |

Both can be open at the same time without interfering.

## Features

- **Its own panel**: a right-sidebar tab, one per session, opened like the built-in sidebar tabs.
- **Empty context**: starts from your first message; it cannot see the main session and cannot pollute it.
- **Zero local execution**: no built-in tools inside the side thread; any tool call is rejected by the host before it runs.
- **Model and reasoning effort**: the model pill opens a card picker grouped by provider; defaults to the main session's current model, and changes stay local to this thread.
- **Images**: pick them with the paperclip, or paste them straight into the composer.
- **Web on demand**: off by default; when on, only `web_search` / `web_fetch` / `research` are allowed.
- **Two-way reading, both explicit**:
  - *Read from the panel* switch: only while the panel is open does the main session get the ability to read it — and only when you explicitly ask in that turn.
  - *Read the main session*: three states, Allow / Ask / Deny. With "Ask", a confirmation bar appears in the panel before anything is read, and it times out after two minutes.
- **Closed means gone**: closing the panel unloads the reading tool immediately, so a session with the panel closed is untouched.
- **Clear means delete**: clearing removes the thread and its transcript; the next message starts a fresh one.
- **Lifecycle**: transcripts survive a host restart (cold resume); archiving the parent deletes the side thread and shows a tombstone; deleting the parent cleans up as well.
- **One per session**: a session can only have one side thread, even with multiple windows.

## Usage

1. Open **Side Freedom Chat** in the right sidebar of any session.
2. Send a message — the thread is created on the first message, not when the panel is opened.
3. Switch models via the model pill; reasoning effort appears for models that support it.
4. Paste or attach images with the paperclip.
5. To let the main session read this panel: turn on the switch, then say "read the side chat" in the main session.
6. To let this panel read the main session: set the pill to Allow (or Ask for per-read confirmation).
7. To start over: press the trash button — the thread is deleted.

## Security model

- The side thread's tool allow-list is **empty**, and a host-level `tools/pre-execute` gate rejects anything that slips through visibility.
- The main session's reading tool is mounted **on demand**: only while the panel is open and the switch is on.
- Reads are limited to the last 20 **user/assistant** messages; tool calls and tool results are never transferred.
- Web tools are off by default and restricted to three names when enabled.

## Data and privacy

- Registry: `~/.dsh/freedomchat/threads.json` (mapping, switches, model only).
- Transcripts: stored like any other DSH session under `~/.dsh/sessions/<project>/<id>/`.
- No telemetry, no background requests; only the web tools you enable reach the network.

## Requirements and installation

- DSH `>= 0.2.2-rc.3`, Node `>= 22`; works in both Desktop and Web.
- From a release: `dsh plugin --profile desktop add <url to the .tgz>`.
- From a local checkout: `dsh plugin --profile desktop add link:<plugin dir>`.
- Restart DSH after installing; client-only changes afterwards just need a page refresh.
- **No companion plugin**: the right sidebar ships with DSH, so this works with or without `dsh-better-sidebar`, and both can coexist.

## Known limitations

- While the panel is closed the reading tool is absent from the main session's tool list, so asking for it then yields `unknown tool`. That is the price of "closed means no effect".
- Archive detection polls once a second; an archive immediately undone within that second can be missed.
- Sessions with `origin: subagent` are not listed in the DSH session list (host behaviour), so the side thread is only visible in its panel.
