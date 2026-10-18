import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "bun:test";
import { isProtocolPointer, main, mainFromNotifyArguments, notifierForThread } from "../plugins/codex-claude-notify/hooks/notify.mjs";

const thread = "12345678-1234-1234-1234-123456789abc";
const pointer = "Read /tmp/exchange/decision.md and follow it.";
let sequence = 0;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ccn-channel-"));
  const directory = join(root, "claude-channels");
  mkdirSync(directory, { mode: 0o700 });
  const json = join(root, "env.json");
  const entry = join(directory, thread);
  const credentials = { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/channel.sock", CLAUDE_CODE_MESSAGING_TOKEN: "fixture-channel-token" };
  writeFileSync(json, JSON.stringify(credentials), { mode: 0o600 });
  writeFileSync(entry, `${json}\n`, { mode: 0o600 });
  return { root, directory, json, entry, credentials, environment: {
    CODEX_HOME: root,
    XDG_RUNTIME_DIR: root,
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/legacy.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "fixture-legacy-token",
  } };
}

function withFixture(action) {
  const f = fixture();
  try { return action(f); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

test("thread registry overrides environment, refreshes credentials, and normalizes UUID case", () => withFixture((f) => {
  assert.equal(notifierForThread(thread.toUpperCase(), f.environment).token, "fixture-channel-token");
  writeFileSync(f.json, JSON.stringify({ ...f.credentials, CLAUDE_CODE_MESSAGING_TOKEN: "fixture-replacement-token" }));
  assert.equal(notifierForThread(thread, f.environment).token, "fixture-replacement-token");
  writeFileSync(f.entry, f.json);
  assert.equal(notifierForThread(thread, f.environment).token, "fixture-replacement-token");
}));

test("missing registry directory or entry preserves environment behavior", () => withFixture((f) => {
  rmSync(f.entry);
  assert.equal(notifierForThread(thread, f.environment).token, "fixture-legacy-token");
  rmSync(f.directory, { recursive: true });
  assert.equal(notifierForThread(thread, f.environment).token, "fixture-legacy-token");
  delete f.environment.CLAUDE_CODE_MESSAGING_TOKEN;
  delete f.environment.CLAUDE_CODE_MESSAGING_SOCKET;
  assert.equal(notifierForThread(thread, f.environment), null);
}));

test("HOME fallback and explicit CODEX_HOME select the same registry", () => withFixture((f) => {
  mkdirSync(join(f.root, ".codex", "claude-channels"), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.root, ".codex", "claude-channels", thread), `${f.json}\n`, { mode: 0o600 });
  const environment = { ...f.environment, HOME: f.root, CODEX_HOME: "" };
  assert.equal(notifierForThread(thread, environment).token, "fixture-channel-token");
  delete environment.CODEX_HOME;
  assert.equal(notifierForThread(thread, environment).token, "fixture-channel-token");
}));

test("non-UUID legacy ids never form registry filenames", () => withFixture((f) => {
  assert.equal(notifierForThread("../env.json", f.environment).token, "fixture-legacy-token");
}));

test("a relative Codex home keeps environment delivery", () => withFixture((f) => {
  assert.equal(notifierForThread(thread, { ...f.environment, CODEX_HOME: "relative-home" }).token, "fixture-legacy-token");
  assert.equal(notifierForThread(thread, { ...f.environment, CODEX_HOME: "", HOME: "relative-home" }).token, "fixture-legacy-token");
}));

const invalidCases = {
  "directory permissions": (f) => chmodSync(f.directory, 0o755),
  "directory symlink": (f) => { rmSync(f.directory, { recursive: true }); symlinkSync(f.root, f.directory); },
  "directory file": (f) => { rmSync(f.directory, { recursive: true }); writeFileSync(f.directory, "fixture"); },
  "entry permissions": (f) => chmodSync(f.entry, 0o640),
  "entry symlink": (f) => { rmSync(f.entry); symlinkSync(f.json, f.entry); },
  "dangling entry symlink": (f) => { rmSync(f.entry); symlinkSync(join(f.root, "absent"), f.entry); },
  "entry directory": (f) => { rmSync(f.entry); mkdirSync(f.entry, { mode: 0o700 }); },
  "entry fifo": (f) => { rmSync(f.entry); assert.equal(spawnSync("mkfifo", ["-m", "600", f.entry]).status, 0); },
  "entry oversized": (f) => writeFileSync(f.entry, "/".repeat(4097)),
  "entry relative path": (f) => writeFileSync(f.entry, "env.json\n"),
  "entry extra newline": (f) => writeFileSync(f.entry, `${f.json}\n\n`),
  "entry NUL": (f) => writeFileSync(f.entry, `${f.json}\0`),
  "missing JSON": (f) => rmSync(f.json),
  "JSON symlink": (f) => { rmSync(f.json); symlinkSync(f.entry, f.json); },
  "JSON permissions": (f) => chmodSync(f.json, 0o644),
  "JSON directory": (f) => { rmSync(f.json); mkdirSync(f.json, { mode: 0o700 }); },
  "JSON fifo": (f) => { rmSync(f.json); assert.equal(spawnSync("mkfifo", ["-m", "600", f.json]).status, 0); },
  "JSON oversized": (f) => writeFileSync(f.json, " ".repeat(16385)),
  "JSON malformed": (f) => writeFileSync(f.json, "fixture-malformed-json"),
  "JSON array": (f) => writeFileSync(f.json, "[]"),
  "JSON null": (f) => writeFileSync(f.json, "null"),
  "JSON extra key": (f) => writeFileSync(f.json, JSON.stringify({ ...f.credentials, extra: "fixture" })),
  "JSON empty token": (f) => writeFileSync(f.json, JSON.stringify({ ...f.credentials, CLAUDE_CODE_MESSAGING_TOKEN: "" })),
  "JSON wrong type": (f) => writeFileSync(f.json, JSON.stringify({ ...f.credentials, CLAUDE_CODE_MESSAGING_TOKEN: 1 })),
  "JSON relative socket": (f) => writeFileSync(f.json, JSON.stringify({ ...f.credentials, CLAUDE_CODE_MESSAGING_SOCKET: "relative" })),
};
// each case must fail on its own check, so removing that check cannot pass on an unrelated error.
const unsafeOpen = /cannot be opened safely/;
const unsafeMode = /ownership or permissions are unsafe/;
const wrongType = /invalid file type/;
const oversized = /exceeds size limit/;
const badEntry = /must name an absolute JSON path/;
const badShape = /exactly two nonempty strings/;
const expectedDiagnostics = {
  "directory permissions": unsafeMode,
  "directory symlink": unsafeOpen,
  "directory file": unsafeOpen,
  "entry permissions": unsafeMode,
  "entry symlink": unsafeOpen,
  "dangling entry symlink": unsafeOpen,
  "entry directory": wrongType,
  "entry fifo": wrongType,
  "entry oversized": oversized,
  "entry relative path": badEntry,
  "entry extra newline": badEntry,
  "entry NUL": badEntry,
  "missing JSON": unsafeOpen,
  "JSON symlink": unsafeOpen,
  "JSON permissions": unsafeMode,
  "JSON directory": wrongType,
  "JSON fifo": wrongType,
  "JSON oversized": oversized,
  "JSON malformed": /not valid JSON/,
  "JSON array": badShape,
  "JSON null": badShape,
  "JSON extra key": badShape,
  "JSON empty token": badShape,
  "JSON wrong type": badShape,
  "JSON relative socket": /socket path must be absolute/,
};
test("every refusal case names its expected diagnostic", () => {
  assert.deepEqual(Object.keys(expectedDiagnostics).sort(), Object.keys(invalidCases).sort());
});
for (const [name, mutate] of Object.entries(invalidCases)) {
  test(`present channel refuses fallback: ${name}`, () => withFixture((f) => {
    mutate(f);
    assert.throws(() => notifierForThread(thread, f.environment), (error) => {
      assert.match(error.message, expectedDiagnostics[name]);
      assert.ok(!error.message.includes("fixture-malformed-json"));
      assert.ok(!error.message.includes(f.root));
      return true;
    });
  }));
}

for (const field of ["directory", "entry", "json"]) {
  test.skipIf(process.getuid() !== 0)(`foreign ownership rejected: ${field}`, () => withFixture((f) => {
    chownSync(f[field], 1, 1);
    assert.throws(() => notifierForThread(thread, f.environment), /ownership/);
  }));
}

async function invoke(f, overrides = {}, legacy = false) {
  let diagnostics = "";
  const stderr = { write: (value) => { diagnostics += value; } };
  const payload = { session_id: thread, hook_event_name: "Stop", last_assistant_message: pointer, ...overrides };
  if (legacy) {
    await mainFromNotifyArguments([JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, "last-assistant-message": payload.last_assistant_message })], { environment: f.environment, stderr });
  } else {
    await main({ stdin: Readable.from([JSON.stringify(payload)]), environment: f.environment, stderr });
  }
  return diagnostics;
}

test("both entry points deliver using registered credentials without inherited credentials", async () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    const socket = `/tmp/ccn-channel-${process.pid}-${sequence++}.sock`;
    const server = createServer();
    try {
      delete f.environment.CLAUDE_CODE_MESSAGING_SOCKET;
      delete f.environment.CLAUDE_CODE_MESSAGING_TOKEN;
      writeFileSync(f.json, JSON.stringify({ ...f.credentials, CLAUDE_CODE_MESSAGING_SOCKET: socket }));
      const received = new Promise((resolve) => server.once("connection", (client) => {
        let frames = "";
        client.on("data", (chunk) => { frames += chunk; });
        client.on("end", () => resolve(frames));
      }));
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
      assert.equal(await invoke(f, {}, legacy), "");
      assert.equal(JSON.parse((await received).split("\n")[0]).token, "fixture-channel-token");
    } finally {
      server.close();
      rmSync(socket, { force: true });
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("protocol pointer grammar accepts only the two-peers lines", () => {
  for (const message of [
    pointer,
    "  Read /a/b.md and follow it.\nfurther context",
    "`Read /a/b.md and follow it.`",
    "Board changed: /x/board #12",
    "seen #4",
    "seen #4\nboard read",
    "seen #4\r\nboard read",
    "Read /a b/c.md and follow it.",
    "Board changed: /a b/board #3",
  ]) assert.ok(isProtocolPointer(message), message);
  for (const message of [
    "Работаю в /work/clocktrim.",
    "Read relative.md and follow it.",
    "Read /a/b.md and follow it. Also more",
    "Read /a/plan.md and follow it. Then check the board and follow it.",
    "Board changed: /x/board #12, answered in #11",
    "Done.\nRead /a/b.md and follow it.",
    "Board changed: /x/board",
    "seen #4 thanks",
    "registry restored check",
    "",
    undefined,
  ]) assert.ok(!isProtocolPointer(message), String(message));
});

test("registered channel stays silent for a turn end that is not a protocol pointer", async () => {
  for (const legacy of [false, true]) {
    for (const [message, expected] of [["status update for the user", 0], [pointer, 1]]) {
      const f = fixture();
      const socket = `/tmp/ccn-channel-${process.pid}-${sequence++}.sock`;
      const server = createServer();
      let connections = 0;
      server.on("connection", (client) => { connections++; client.destroy(); });
      try {
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
        writeFileSync(f.json, JSON.stringify({ ...f.credentials, CLAUDE_CODE_MESSAGING_SOCKET: socket }));
        const diagnostics = await invoke(f, { last_assistant_message: message }, legacy);
        assert.equal(connections, expected, `${legacy ? "notify" : "stop"}: ${message}`);
        if (expected === 0) assert.equal(diagnostics, "");
      } finally {
        server.close(); rmSync(socket, { force: true }); rmSync(f.root, { recursive: true, force: true });
      }
    }
  }
});

test("registered channel retains disable, source filter and Stop-only gates", async () => {
  const f = fixture();
  try {
    writeFileSync(f.json, "not-json");
    f.environment.CODEX_CLAUDE_NOTIFY_DISABLE = "1";
    assert.equal(await invoke(f), "");
    assert.equal(await invoke(f, {}, true), "");
    delete f.environment.CODEX_CLAUDE_NOTIFY_DISABLE;
    assert.equal(await invoke(f, { hook_event_name: "SubagentStop" }), "");
    f.environment.CODEX_CLAUDE_NOTIFY_SOURCES = "cli";
    const transcript = join(f.root, "rollout.jsonl");
    for (const meta of [{ id: thread, source: "exec" }, { id: "other-thread", source: "cli" }]) {
      writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: meta }) + "\n");
      assert.equal(await invoke(f, { transcript_path: transcript }), "");
    }
    writeFileSync(transcript, JSON.stringify({ type: "session_meta", payload: { id: thread, source: "cli" } }) + "\n");
    assert.match(await invoke(f, { transcript_path: transcript }), /not valid JSON/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("unsafe channel diagnostics are fixed and never expose JSON contents", async () => {
  const f = fixture();
  try {
    writeFileSync(f.json, "fixture-malformed-json");
    for (const legacy of [false, true]) {
      const diagnostic = await invoke(f, {}, legacy);
      assert.match(diagnostic, /channel credentials are not valid JSON/);
      assert.ok(!diagnostic.includes("fixture-malformed-json"));
      assert.ok(!diagnostic.includes(f.root));
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("failed channel connection does not retry against valid environment credentials", async () => {
  const f = fixture();
  const socket = `/tmp/ccn-channel-${process.pid}-${sequence++}.sock`;
  const server = createServer();
  let connections = 0;
  server.on("connection", (client) => { connections++; client.destroy(); });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    f.environment.CLAUDE_CODE_MESSAGING_SOCKET = socket;
    for (const legacy of [false, true]) assert.match(await invoke(f, {}, legacy), /connect/);
    assert.equal(connections, 0);
  } finally {
    server.close(); rmSync(socket, { force: true }); rmSync(f.root, { recursive: true, force: true });
  }
});
