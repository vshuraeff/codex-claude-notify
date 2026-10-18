# Changelog

## 0.1.3 — 2026-10-18

- Resolve Claude Code messaging credentials per thread: for a UUID thread id, both the `Stop` hook and the legacy `notify` command first read `<Codex home>/claude-channels/<thread>`, which names a private JSON file holding the socket and token. A Codex session started outside Claude Code can then deliver once Claude registers the channel, and keeps delivering after Claude restarts without restarting Codex. An absent registry, or a relative Codex home, keeps the previous environment behavior.
- Open the registry directory, entry and JSON without following symlinks and without blocking on FIFOs; check type, owner and private mode through the descriptors and bound the reads. A present but unsafe or malformed channel skips delivery with a fixed diagnostic and never falls back to inherited credentials.
- Tests: each refusal case asserts its own diagnostic, and hook subprocess tests use an empty Codex home instead of the developer's.

## 0.1.2 — 2026-10-08

- Add `CODEX_CLAUDE_NOTIFY_SOURCES`: when set, a `Stop` completion is delivered only if the session's rollout header records one of the listed sources, so `codex exec` runs started from an interactive session no longer deliver through the environment they inherit. Unset keeps the previous behavior. Checked against Codex CLI 0.160.1 rollouts (`cli`, `exec`, subagent).

## 0.1.1 — 2026-09-21

- Deliver Codex completions in Claude Code's native `cross-session-message` envelope. Claude 2.1.277 and 2.1.278 escape the older `teammate-message` wrapper; plain text does not activate the named-peer UI.
- Sanitize sender labels and embedded harness-tag prefixes, including Unicode closing peer tags. Preserve the outer envelope and the 64 KiB UTF-8 byte limit when truncating a response.
- Add regression coverage for sender-name boundaries, nested tags, Unicode variants, exact-size payloads, and tags formed at a truncation boundary. Update the real Codex socket smoke assertions for the native envelope.
- Clarify installation updates, deduplication, smoke-test scope, and the versions on which plugin-hook execution was checked.
