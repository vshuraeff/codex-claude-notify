# Changelog

## 0.1.2 — 2026-10-08

- Add `CODEX_CLAUDE_NOTIFY_SOURCES`: when set, a `Stop` completion is delivered only if the session's rollout header records one of the listed sources, so `codex exec` runs started from an interactive session no longer deliver through the environment they inherit. Unset keeps the previous behavior. Checked against Codex CLI 0.160.1 rollouts (`cli`, `exec`, subagent).

## 0.1.1 — 2026-09-21

- Deliver Codex completions in Claude Code's native `cross-session-message` envelope. Claude 2.1.277 and 2.1.278 escape the older `teammate-message` wrapper; plain text does not activate the named-peer UI.
- Sanitize sender labels and embedded harness-tag prefixes, including Unicode closing peer tags. Preserve the outer envelope and the 64 KiB UTF-8 byte limit when truncating a response.
- Add regression coverage for sender-name boundaries, nested tags, Unicode variants, exact-size payloads, and tags formed at a truncation boundary. Update the real Codex socket smoke assertions for the native envelope.
- Clarify installation updates, deduplication, smoke-test scope, and the versions on which plugin-hook execution was checked.
