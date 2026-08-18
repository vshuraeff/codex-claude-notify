# codex-claude-notify

A Codex CLI hook that delivers the end of a Codex turn, together with the text of Codex's final response, into the inbox of the Claude Code session that launched Codex.

Claude Code can start Codex headless (`codex exec`) and keep working while Codex runs. It then has no reliable signal for when that run finished. Polling the process or its output file on a timer costs turns and adds latency, and asking the Codex agent to announce its own completion only works when the model decides to do it.

This hook takes the model out of that path. Codex itself runs the configured hook program after every completed turn, so the signal comes from the CLI. The launching Claude Code session receives the final Codex response as an inbox message as soon as the turn ends.

```text
Claude Code -> codex exec -> Codex Stop hook -> Claude Code session inbox
```

Delivery uses the per-session Unix domain socket that Claude Code exports to the processes it spawns, in `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. A `codex exec` started from that session inherits both variables and passes them to the hook program.

## Install

```sh
npm install -g codex-claude-notify
```

If the package is not yet available on the npm registry, install directly from GitHub with the command below; the same command also installs the current `master` instead of the published version:

```sh
npm install -g vshuraeff/codex-claude-notify
```

Then register a `Stop` hook in `~/.codex/hooks.json` (`~/.codex` is the default `CODEX_HOME`; adjust if you have overridden it):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codex-claude-notify"
          }
        ]
      }
    ]
  }
}
```

The nesting matters: `Stop` holds matcher groups, and each group holds its own `hooks` array. A flat entry placed directly in the `Stop` array is ignored without an error message. If the file already exists, merge this `Stop` group into it rather than replacing the file.

Finally, trust the hook once: start interactive `codex`, run `/hooks`, and approve the entry. Trust is Codex's deliberate security gate for running local commands. Until the hook is trusted, headless runs skip it silently — no output, no error. Changing the hook command later invalidates the trust and requires approving it again.

## Legacy alternative

Codex's older `notify` mechanism needs no trust step. Set it in `~/.codex/config.toml` (`CODEX_HOME`, as above):

```toml
notify = ["codex-claude-notify"]
```

This works immediately, but Codex passes the whole event payload as a single argv argument, which is known to fail on very long final responses (openai/codex#34878).

In this mode a sender name is passed on the command line, so that several Codex runs reporting into one Claude Code session can be told apart:

```toml
notify = ["codex-claude-notify", "--from", "reviewer"]
```

## Codex plugin

The repository is also a Codex plugin marketplace:

```sh
codex plugin marketplace add vshuraeff/codex-claude-notify
codex plugin add codex-claude-notify@codex-claude-notify
```

Plugin-provided hooks are not executed by published Codex CLI builds — verified on 0.147.0 and 0.148.0-alpha.21, as of 2026-08-18. Installing the plugin today registers it and delivers nothing. Once Codex runs plugin hooks, this becomes the install path that needs no manual `hooks.json` edit.

## Behavior

The message content is a `<teammate-message>` envelope carrying the final assistant message of the Codex turn:

```text
<teammate-message teammate_id="codex" summary="[Codex turn complete] first line of the response">
[Codex turn complete] full text of the final assistant message

(codex thread 0199e0c1-..., cwd /path/to/project)
</teammate-message>
```

- `teammate_id` is `codex`, or `codex:<name>` when a sender name is configured.
- `summary` is the first non-blank line of the body, capped at 200 code points and XML-escaped.
- The trailing metadata paragraph reports the Codex thread id and working directory taken from the event; it is omitted when the event carries neither.
- The whole message, envelope included, stays within 65536 bytes. A longer response is cut at a UTF-8 character boundary and marked with `[notification truncated]`; the metadata paragraph is preserved.
- A turn that ends without a final assistant message is reported as `The Codex turn finished without a final assistant message.`
- A literal `</teammate-message>` inside the response is escaped so it cannot close the envelope early.

When neither `CLAUDE_CODE_MESSAGING_SOCKET` nor `CLAUDE_CODE_MESSAGING_TOKEN` is present, the hook sends nothing and prints nothing. A global Codex configuration is therefore safe for Codex sessions started from a plain shell, an editor, or CI. Delivery failures are reported on stderr only; the hook always exits 0, so it never fails a Codex turn.

Two environment variables control it:

- `CODEX_CLAUDE_NOTIFY_FROM` sets the sender name, producing `teammate_id="codex:<name>"`. In the legacy mode `--from` overrides it.
- `CODEX_CLAUDE_NOTIFY_DISABLE`, set to any non-empty value, is a kill switch. In the `Stop` hook (stdin) mode the hook still reads stdin to EOF before exiting quietly, since leaving it unread hangs the Codex turn; in the legacy argv mode it never reads stdin at all, so it exits quietly without touching it.

## Requirements

- macOS or Linux. Delivery goes through a Unix domain socket, so Windows is not supported.
- Node.js 20 or newer, on `PATH`.
- Codex CLI with hook support for the `Stop` path, verified on 0.147.0. The legacy path needs only the `notify` configuration option.
- Claude Code 2.1.228 or newer, with cross-session messaging enabled.

Claude Code does not expose the messaging socket when feature-flag fetching is disabled. `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` must all be unset for the Claude Code session that launches Codex — see Troubleshooting for a command that checks this.

For automatic inbound delivery, set this in Claude Code settings:

```json
{
  "crossSessionInbound": "accept"
}
```

Without it, Claude Code asks before accepting the first message from another session.

## Security

The session token is read only from the environment of the running process. It is not logged, printed, or written to disk, and the only place it goes is the auth frame on the session's own socket. No network connection is made.

Claude Code treats the delivered text as a message from another session, which is data and not consent. Such a message cannot approve a permission prompt, change configuration, or execute commands or slash commands.

The hook sends the token to whatever Unix socket the `CLAUDE_CODE_MESSAGING_SOCKET` environment variable points at by absolute path. The trust boundary is the integrity of the process environment and of the socket's filesystem location: whoever controls that environment controls where the delivery goes.

## Troubleshooting

If a message never arrives, check in order:

- Is the hook trusted? An untrusted `Stop` hook is skipped silently on headless runs. Start interactive `codex` and run `/hooks` to trust it.
- Are both `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` present in the Codex process's environment? Outside Claude Code the hook stays silent by design; with only one of the two set, it prints the reason to stderr.
- Are the feature-flag variables clear: `env | grep -E 'DISABLE_TELEMETRY|DO_NOT_TRACK|DISABLE_GROWTHBOOK|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'` should print nothing.
- Delivery errors go to the Codex process's stderr, and the hook always exits 0, so a failed delivery never fails the Codex turn.
- For automation or CI where the interactive trust step is unavailable, `codex exec --dangerously-bypass-hook-trust` skips it; use this only against an isolated, disposable `CODEX_HOME`, never a real one.

## Testing

From a clone of the repository:

```sh
npm test
```

This is offline and safe to run anywhere.

```sh
bash test/e2e/smoke.sh [persistent-home-dir]
```

This is a live test, not offline: it copies `~/.codex/auth.json` into an isolated, throwaway `CODEX_HOME` and runs two real `codex exec` calls, which are billed. It requires an installed and authenticated `codex` CLI, `node`, and `jq`.

## Releases

This project follows [semantic versioning](https://semver.org/); before 1.0, minor version bumps may include breaking changes.
To cut a release, run `npm version patch|minor|major`, which bumps both `package.json` and `plugin.json` through the version lifecycle script and creates a `vX.Y.Z` tag; then run `git push --follow-tags`.
Then run `npm publish`. Publishing requires an npm account with publish rights for `codex-claude-notify`; before the first publish, the package is available only from GitHub using the install command above.
The Codex plugin marketplace picks up git updates automatically; npm users update with `npm update -g codex-claude-notify`.

## License

MIT. See [LICENSE](LICENSE).

## References

- [Codex external notifications](https://developers.openai.com/codex/config-advanced/#notifications)
- [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
