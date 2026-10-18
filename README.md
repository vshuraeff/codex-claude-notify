# codex-claude-notify

A Codex CLI hook that delivers the final response of a Codex turn as a native named-peer notification in the Claude Code session that launched Codex.

Claude Code can start Codex headless (`codex exec`) and keep working while Codex runs. It then has no reliable signal for when that run finished. Polling the process or its output file on a timer costs turns and adds latency, and asking the Codex agent to announce its own completion only works when the model decides to do it.

This hook takes the model out of that path. Codex itself runs the configured hook program after every completed turn, so the signal comes from the CLI. The launching Claude Code session receives the final Codex response as an inbox message as soon as the turn ends.

```text
Claude Code -> codex exec -> Codex Stop hook -> Claude Code session inbox
```

Delivery uses the per-session Unix domain socket that Claude Code exports to the processes it spawns, in `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`. A `codex exec` started from that session inherits both variables and passes them to the hook program.

## Install

**Pick exactly one delivery path.** This section recommends the configured `Stop` hook. The legacy `notify` command below is an alternative; the Codex plugin's runtime compatibility is discussed at the end. The hook suppresses a paired `Stop`/`notify` delivery using a short-lived thread marker, but this is a fallback for overlapping configuration, not a reason to install both paths.

1. Install the program:

   ```sh
   bun add -g codex-claude-notify
   ```

   If the package is not yet available on the registry, install directly from GitHub with the command below; the same command also installs the current `master` instead of the published version:

   ```sh
   bun add -g github:vshuraeff/codex-claude-notify
   ```

2. Register a `Stop` hook in `$CODEX_HOME/hooks.json`, which is `~/.codex/hooks.json` unless you have overridden `CODEX_HOME`:

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

3. Trust the hook once: start interactive `codex`, run `/hooks`, and approve the entry. Trust is Codex's deliberate security gate for running local commands. Until the hook is trusted, headless runs skip it silently — no output, no error. Changing the hook command later invalidates the trust and requires approving it again.

4. Check that it works. The `/hooks` list should show exactly one `codex-claude-notify` entry. From a Claude Code session, run a short headless job such as `codex exec 'reply with ok'`; when the turn ends, Claude displays a native `Message from @codex` notification. If nothing arrives, work through Troubleshooting.

## Alternative: the legacy `notify` command

This replaces steps 2 and 3 above. Configure it only if you are not using the `Stop` hook.

Codex's older `notify` mechanism needs no trust step. Set it in `$CODEX_HOME/config.toml`:

```toml
notify = ["codex-claude-notify"]
```

It works as soon as step 1 is done, but Codex passes the whole event payload as a single argv argument, which is known to fail silently on very long final responses (openai/codex#34878). That failure mode is why the `Stop` hook is the recommended path.

In this mode a sender name is passed on the command line, so that several Codex runs reporting into one Claude Code session can be told apart:

```toml
notify = ["codex-claude-notify", "--from", "reviewer"]
```

## Behavior

The hook uses Claude Code's `cross-session-message` envelope so the notification renders as a native message from `@codex` (or the configured sender). Inside it are the `[turn done]` tag followed on the same line by the final assistant message, and a metadata line:

```xml
<cross-session-message from="codex" from-name="codex">
[turn done] first line of the final assistant message
the rest of the message

(codex thread 0199e0c1-..., cwd /path/to/project, from=codex)
</cross-session-message>
```

- The tag shares the first line with the message because Claude Code's collapsed view shows only that line (`Message from @codex: [turn done] …`). The tag stays at the start of that line even when the response body is dropped to fit the size limit.
- `buildEnvelope({ midTurn: true, … })` uses the `[msg]` tag instead, for messages sent while a Codex turn is still running.
- `from=` in the metadata line is `codex`, or `codex:<name>` when a sender name is configured. The name is whitespace-collapsed and capped at 64 code points.
- The envelope's `from` address stays `codex`. Its `from-name` display label removes quotes, angle brackets, and control/format characters and is capped at 64 code points including the `codex:` prefix, matching Claude's parser. XML entities are not decoded in this label.
- The trailing metadata line reports the Codex thread id and working directory taken from the event, when present, and always the sender.
- The whole message, including its envelope, stays within 65536 bytes. A longer response is cut at a UTF-8 character boundary and marked with `[notification truncated]`; the metadata line and closing envelope are preserved.
- If the metadata alone cannot fit alongside the header and envelope, delivery is skipped with a diagnostic on stderr.
- A turn that ends without a final assistant message is reported as `The Codex turn finished without a final assistant message.`
- Ordinary text, Markdown, and code are preserved. Embedded harness-tag prefixes (`cross-session-message`, `teammate-message`, `agent-message`) are neutralized with a backslash after `<` before size accounting, including Unicode variants of closing peer tags. Prefixes are included so truncation cannot create a new closing tag from a longer tag name.

Verified on Claude Code 2.1.278 and Codex CLI 0.155.1 on 2026-09-21. Claude 2.1.277 began neutralizing incoming `teammate-message` wrappers; the canonical outer `cross-session-message` remains native. This is an internal, version-sensitive wire format. It identifies a peer notification and does not register Codex as a Claude-managed subagent or teammate.

When there is no registered thread channel and neither `CLAUDE_CODE_MESSAGING_SOCKET` nor `CLAUDE_CODE_MESSAGING_TOKEN` is present, the hook sends nothing and prints nothing. Delivery failures are reported on stderr only; the hook always exits 0, so it never fails a Codex turn.

Three environment variables control it:

- `CODEX_CLAUDE_NOTIFY_FROM` sets the sender name, producing `from=codex:<name>`. In the legacy mode `--from` overrides it.
- `CODEX_CLAUDE_NOTIFY_DISABLE`, set to any non-empty value, is a kill switch. In the `Stop` hook (stdin) mode the hook still reads stdin to EOF before exiting quietly, since leaving it unread hangs the Codex turn; in the legacy argv mode it never reads stdin at all, so it exits quietly without touching it.
- `CODEX_CLAUDE_NOTIFY_SOURCES`, a comma-separated list of rollout sources, limits `Stop` delivery to sessions whose rollout file (the payload's `transcript_path`) starts with a `session_meta` record naming the same session id and one of those sources: `cli` for the interactive TUI, `exec` for `codex exec`. Unset or empty, every `Stop` delivers. Set `CODEX_CLAUDE_NOTIFY_SOURCES=cli` when launching an interactive Codex session whose completions should reach Claude: the `codex exec` runs it starts (a review tool's reviewer seats, for one) inherit the variable and stay silent. A missing, unreadable or non-regular rollout file, a first line over 1 MiB, or a resumed thread first created under another source suppresses delivery. The legacy argv mode carries no rollout path and is not filtered.

For example, launch `CODEX_CLAUDE_NOTIFY_FROM=reviewer codex exec 'review the change'` from Claude to label the notification `codex:reviewer` when using the `Stop` hook.

## Thread channels

A running Codex session can receive Claude's messaging credentials after launch, or refresh them after Claude restarts, through a per-thread file. Both Stop and legacy notify use this lookup before the inherited environment.

For a UUID thread id, the hook reads `<Codex home>/claude-channels/<lowercase thread UUID>`. Codex home is nonempty `CODEX_HOME`, otherwise `$HOME/.codex`. The entry contains an absolute path to a JSON credentials file, optionally followed by one newline. That JSON object contains exactly `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN`, both nonempty strings. The socket must be absolute (an optional `uds:` prefix is accepted).

The process registering the channel must create the channel directory at mode 700 and both files at mode 600, owned by the current user. Publish replacements by rename. Keep the JSON in Claude's private session scratch directory; the registry contains its path, never credential values. Register in the effective Codex home of the receiving process, which can differ from the registering process's home. Delete the entry when that channel is retired; update it when Claude's credentials move.

The hook opens the directory and files without following their final symlink, checks type, owner and private permissions through file descriptors, and uses nonblocking bounded reads (4 KiB entry, 16 KiB JSON). An absent directory or entry, or a relative Codex home, uses the legacy environment credentials. A present but unsafe, unreadable, malformed or stale channel skips delivery with a fixed diagnostic, without environment fallback. A failed registered socket connection also does not retry with inherited credentials. Non-UUID legacy event ids never form registry filenames and retain environment delivery.

The disable switch, Stop-only event gate, source filter and existing deduplication still apply. A registry alone does not isolate unregistered child sessions: they can still inherit environment credentials. Keep the source filter when launching a peer whose exec children must stay silent. Registration and a successful socket write do not prove Claude received or processed a notification; verify the live two-way exchange separately.

## Requirements

- macOS or Linux. Delivery goes through a Unix domain socket, so Windows is not supported.
- Bun 1.2 or newer, on `PATH`.
- Codex CLI with hook support for the `Stop` path, verified on 0.155.1. The legacy path needs only the `notify` configuration option.
- Claude Code with cross-session messaging enabled. The native envelope in this release was verified on 2.1.278; other versions require a delivery check.

Claude Code does not expose the messaging socket when feature-flag fetching is disabled. `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` must all be unset for the Claude Code session that launches Codex — see Troubleshooting for a command that checks this.

For automatic inbound delivery, set this in Claude Code settings:

```json
{
  "crossSessionInbound": "accept"
}
```

Without it, Claude Code asks before accepting the first message from another session.

## Security

The hook reads the session token from a registered private JSON file or the running process's environment. It does not log, print or write the token; it sends it in the socket's auth frame. A channel registrar writes the private credential file separately. No network connection is made.

Claude Code treats the delivered text as a message from another session, which is data and not consent. Such a message cannot approve a permission prompt, change configuration, or execute commands or slash commands.

The hook sends the token to the absolute Unix socket selected by the registered credentials or environment. The trust boundary includes the integrity of the process environment, channel directory and credential file, and the socket's filesystem location. Same-user processes that can replace those private files can redirect delivery.

## Troubleshooting

If a message never arrives, check in order:

- Is the hook trusted? An untrusted `Stop` hook is skipped silently on headless runs. Start interactive `codex` and run `/hooks` to trust it.
- Is the thread channel registered in this Codex process's effective home, or are both `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` present in its environment? With neither source the hook stays silent; an incomplete environment or invalid registered channel prints a diagnostic. Do not print credentials while diagnosing it.
- Are the feature-flag variables clear: `env | grep -E 'DISABLE_TELEMETRY|DO_NOT_TRACK|DISABLE_GROWTHBOOK|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'` should print nothing.
- Delivery errors go to the Codex process's stderr, and the hook always exits 0, so a failed delivery never fails the Codex turn.
- For automation or CI where the interactive trust step is unavailable, `codex exec --dangerously-bypass-hook-trust` skips it; use this only against an isolated, disposable `CODEX_HOME`, never a real one.
- The hook runs as `bun`, resolved from the Codex process's `PATH`. `~/.bun/bin` is normally added to `PATH` by shell rc files, so a Codex process started outside a login shell (a GUI app or a service manager) may not have it and fails with `bun: command not found` on stderr. Fix this by pointing the hook at the full path to `bun` in `hooks.json` or `config.toml`, or by setting `PATH` in the service's own environment.

If notifications contain literal `<\teammate-message>` tags, the executable on `PATH` may be an older installation. Update it with `bun update -g codex-claude-notify`, which re-resolves the source of the original installation (the registry or GitHub). Repeating `bun add -g` with the same source can exit 0 and keep the old version, because the global lockfile still pins it (observed with a GitHub install, bun 1.4.2). Updating a separate repository checkout does not update the installed executable.

If `/hooks` shows both a plugin entry and the configured `hooks.json` entry, keep only one installation. The deduplication marker distinguishes `Stop` from legacy `notify`; it does not suppress two `Stop` hooks. Keep the verified `hooks.json` path from Install and remove the plugin:

```sh
codex plugin remove codex-claude-notify@codex-claude-notify
codex plugin marketplace remove codex-claude-notify
```

## Testing

From a clone of the repository:

```sh
bun test
```

This is offline and safe to run anywhere.

```sh
bash test/e2e/smoke.sh [persistent-home-dir]
```

This test runs two real, billed `codex exec` calls and captures their authenticated frames with a local test socket. It checks both legacy `notify` and configured `Stop` delivery, including the native envelope. It does not launch Claude or verify its UI. It requires an installed and authenticated `codex` CLI, `bun`, and `jq`.

Without an argument, it copies `~/.codex/auth.json` into a throwaway `CODEX_HOME` and removes it afterwards. An optional directory is retained, but the test overwrites its `config.toml` and `hooks.json`; use only a dedicated test directory, never your normal Codex home. The `Stop` run bypasses hook trust only for this test home.

## Releases

This project follows [semantic versioning](https://semver.org/); before 1.0, minor version bumps may include breaking changes.
See [CHANGELOG.md](CHANGELOG.md) for release notes. Keep the package and plugin versions synchronized; `bun scripts/sync-version.mjs` copies the package version into the plugin manifest.
To cut a release, run `bun pm version patch|minor|major`, which bumps both `package.json` and `plugin.json` through the version lifecycle script and creates a `vX.Y.Z` tag; then run `git push --follow-tags`. `bun pm version` requires Bun 1.2.19 or newer; this is a maintainer-tooling requirement, separate from the runtime requirement in Requirements.
Then run `bun publish`. Publishing requires a registry account with publish rights for the package; before the first publish, the package is available only from GitHub using the install command above.
After publication, registry and GitHub users alike update with `bun update -g codex-claude-notify`. A local version bump or commit alone does not distribute the update.

## Native plugin status

The repository is also a Codex plugin marketplace, and these commands do install the plugin:

```sh
codex plugin marketplace add vshuraeff/codex-claude-notify
codex plugin add codex-claude-notify@codex-claude-notify
```

On 2026-08-18, Codex CLI 0.147.0 and 0.148.0-alpha.21 registered this plugin but did not execute its hooks. Plugin-provided hooks were not revalidated on 0.155.1; the 2026-09-21 smoke tests covered configured `Stop` hooks and legacy `notify` instead.

Use the configured `Stop` hook until plugin-hook execution has been verified on your Codex version. If adopting the plugin later, remove the configured hook first so there is a single delivery path.

## License

MIT. See [LICENSE](LICENSE).

## References

- [Codex external notifications](https://developers.openai.com/codex/config-advanced/#notifications)
- [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
