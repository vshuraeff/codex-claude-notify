import assert from "node:assert";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, test } from "bun:test";

import {
  buildEnvelope,
  dedupeMarkerPath,
  envelopeFromStopPayload,
  escapeXMLAttribute,
  hasFreshDedupeMarker,
  maximumMessageBytes,
  maximumSummaryEscapedBytes,
  maximumStdinBytes,
  maximumTeammateNameRunes,
  normalizeTeammateName,
  notificationMetadata,
  notificationSummary,
  notifierFromEnvironment,
  sendMessage,
  stdinTimeoutFromEnvironment,
  teammateMessageCloseTag,
  teammateMessageIDSuffix,
  teammateMessageOpenTagPrefix,
  teammateMessageOpenTagSuffix,
  truncateUTF8,
  writeDedupeMarker,
} from "../plugins/codex-claude-notify/hooks/notify.mjs";

const notifyScriptPath = fileURLToPath(
  new URL("../plugins/codex-claude-notify/hooks/notify.mjs", import.meta.url),
);
const notifyHooksDirectoryPath = fileURLToPath(
  new URL("../plugins/codex-claude-notify/hooks/", import.meta.url),
);
let socketSequence = 0;

function stopPayload(overrides = {}) {
  return {
    session_id: "thread-123",
    turn_id: "turn-456",
    cwd: "/workspace/project",
    hook_event_name: "Stop",
    last_assistant_message: "Implemented the requested change.",
    stop_hook_active: false,
    ...overrides,
  };
}

function notifyPayload(overrides = {}) {
  return {
    type: "agent-turn-complete",
    "thread-id": "thread-123",
    "turn-id": "turn-456",
    cwd: "/workspace/project",
    "input-messages": ["Implement the requested change."],
    "last-assistant-message": "Implemented the requested change.",
    ...overrides,
  };
}

function isolatedEnvironment(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const name of [
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CODEX_CLAUDE_NOTIFY_DISABLE",
    "CODEX_CLAUDE_NOTIFY_FROM",
    "CODEX_CLAUDE_NOTIFY_STDIN_TIMEOUT_MS",
  ]) {
    if (!(name in overrides)) {
      delete environment[name];
    }
  }
  return environment;
}

function runHook(
  input,
  environment,
  {
    scriptPath = notifyScriptPath,
    cliArgs = [],
    closeStdin = true,
    closeStderr = false,
    nodeArgs = [],
    timeoutMilliseconds = 4000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, scriptPath, ...cliArgs], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimeout;
    const timeout = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 1000);
      }
    }, timeoutMilliseconds);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (closeStderr) {
      child.stderr.destroy();
    }
    child.once("error", (error) => {
      if (timedOut) {
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKillTimeout);
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKillTimeout);
        if (timedOut) {
          reject(new Error("notify hook did not exit before the timeout"));
        } else {
          resolve({ code, signal, stdout, stderr });
        }
      }
    });
    if (closeStdin) {
      child.stdin.end(input);
    }
  });
}

async function listenForFrames() {
  const socketPath = `${tmpdir()}/ccn-${process.pid}-${socketSequence++}.sock`;
  const server = createServer();

  await new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    server.once("error", fail);
    server.listen(socketPath, () => {
      server.off("error", fail);
      resolve();
    });
  });

  const framesReceived = new Promise((resolve, reject) => {
    let settled = false;
    let framesTimeout;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(framesTimeout);
      reject(error);
    };
    const succeed = (received) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(framesTimeout);
      resolve(received);
    };

    server.once("error", fail);
    server.once("connection", (socket) => {
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        received += chunk;
      });
      socket.once("error", fail);
      socket.once("end", () => succeed(received));
    });
    framesTimeout = setTimeout(
      () => fail(new Error("notify hook did not deliver frames before the timeout")),
      4000,
    );
  });
  return { framesReceived, server, socketPath };
}

function parseFrames(received) {
  const lines = received.split("\n");
  assert.strictEqual(lines.at(-1), "");
  assert.strictEqual(lines.length, 3);
  return lines.slice(0, -1).map((line) => JSON.parse(line));
}

async function runDeliveredHook({
  input = "",
  cliArgs = [],
  scriptPath = notifyScriptPath,
  environment = {},
  token = 'token-"exact"',
} = {}) {
  const { framesReceived, server, socketPath } = await listenForFrames();
  try {
    const childEnvironment = isolatedEnvironment({
      CLAUDE_CODE_MESSAGING_SOCKET: `uds:${socketPath}`,
      CLAUDE_CODE_MESSAGING_TOKEN: token,
      ...environment,
    });
    const [result, received] = await Promise.all([
      runHook(input, childEnvironment, {
        scriptPath,
        cliArgs,
        closeStdin: cliArgs.length === 0,
      }),
      framesReceived,
    ]);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
    return { frames: parseFrames(received), result };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertDeliveredFrames(frames, token, envelope) {
  assert.deepStrictEqual(frames, [
    { type: "auth", token },
    {
      type: "user",
      message: { role: "user", content: envelope },
    },
  ]);
}

test("argv --from mode writes a fresh dedupe marker", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = notifyPayload();
  const token = "dedupe-marker-token";
  const environment = isolatedEnvironment({ XDG_RUNTIME_DIR: runtimeDirectory });
  try {
    const { frames } = await runDeliveredHook({
      cliArgs: ["--from", "builder", JSON.stringify(payload)],
      environment,
      token,
    });

    assertDeliveredFrames(
      frames,
      token,
      buildEnvelope({
        threadID: payload["thread-id"],
        cwd: payload.cwd,
        lastAssistantMessage: payload["last-assistant-message"],
        teammateName: "builder",
      }),
    );
    assert.strictEqual(hasFreshDedupeMarker(payload["thread-id"], environment), true);
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("argv --from delivery suppresses the following Stop-hook delivery", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = notifyPayload({ "thread-id": "thread-from-first" });
  const threadID = payload["thread-id"];
  const token = "from-first-token";
  const socketPath = `${runtimeDirectory}/claude-code.sock`;
  let connectionCount = 0;
  const server = createServer(() => {
    connectionCount++;
  });
  try {
    const { frames } = await runDeliveredHook({
      cliArgs: ["--from", "builder", JSON.stringify(payload)],
      environment: { XDG_RUNTIME_DIR: runtimeDirectory },
      token,
    });
    assertDeliveredFrames(
      frames,
      token,
      buildEnvelope({
        threadID,
        cwd: payload.cwd,
        lastAssistantMessage: payload["last-assistant-message"],
        teammateName: "builder",
      }),
    );
    assert.strictEqual(
      hasFreshDedupeMarker(threadID, { XDG_RUNTIME_DIR: runtimeDirectory }),
      true,
    );

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const result = await runHook(
      JSON.stringify(stopPayload({ session_id: threadID })),
      isolatedEnvironment({
        XDG_RUNTIME_DIR: runtimeDirectory,
        CLAUDE_CODE_MESSAGING_SOCKET: `uds:${socketPath}`,
        CLAUDE_CODE_MESSAGING_TOKEN: token,
      }),
    );
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(connectionCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("marker claim filesystem errors do not suppress Stop-hook delivery", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = stopPayload({ session_id: "thread-marker-claim-error" });
  const environment = { XDG_RUNTIME_DIR: runtimeDirectory };
  const markerPath = dedupeMarkerPath(payload.session_id, environment);
  const markerDirectory = dirname(markerPath);
  const token = "marker-claim-error-token";
  try {
    writeDedupeMarker(payload.session_id, environment);
    rmSync(markerPath);
    chmodSync(markerDirectory, 0o500);

    const { frames } = await runDeliveredHook({
      input: JSON.stringify(payload),
      environment,
      token,
    });
    assertDeliveredFrames(frames, token, envelopeFromStopPayload(payload));
  } finally {
    chmodSync(markerDirectory, 0o700);
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Stop-hook delivery suppresses the following argv --from delivery", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = notifyPayload({ "thread-id": "thread-stop-first" });
  const threadID = payload["thread-id"];
  const stopHookPayload = stopPayload({ session_id: threadID });
  const token = "stop-first-token";
  const socketPath = `${runtimeDirectory}/claude-code.sock`;
  let connectionCount = 0;
  const server = createServer(() => {
    connectionCount++;
  });
  try {
    const { frames } = await runDeliveredHook({
      input: JSON.stringify(stopHookPayload),
      environment: { XDG_RUNTIME_DIR: runtimeDirectory },
      token,
    });
    assertDeliveredFrames(frames, token, envelopeFromStopPayload(stopHookPayload));
    assert.strictEqual(
      hasFreshDedupeMarker(threadID, { XDG_RUNTIME_DIR: runtimeDirectory }),
      true,
    );

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const result = await runHook(
      "",
      isolatedEnvironment({
        XDG_RUNTIME_DIR: runtimeDirectory,
        CLAUDE_CODE_MESSAGING_SOCKET: `uds:${socketPath}`,
        CLAUDE_CODE_MESSAGING_TOKEN: token,
      }),
      { cliArgs: ["--from", "builder", JSON.stringify(payload)] },
    );
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(connectionCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("two Stop-hook deliveries for one session both send", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = stopPayload({ session_id: "thread-stop-only" });
  const environment = { XDG_RUNTIME_DIR: runtimeDirectory };
  const firstToken = "stop-only-first-token";
  const secondToken = "stop-only-second-token";
  try {
    const { frames: firstFrames } = await runDeliveredHook({
      input: JSON.stringify(payload),
      environment,
      token: firstToken,
    });
    assertDeliveredFrames(firstFrames, firstToken, envelopeFromStopPayload(payload));
    assert.strictEqual(hasFreshDedupeMarker(payload.session_id, environment), true);

    const { frames: secondFrames } = await runDeliveredHook({
      input: JSON.stringify(payload),
      environment,
      token: secondToken,
    });
    assertDeliveredFrames(secondFrames, secondToken, envelopeFromStopPayload(payload));
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("fresh dedupe marker skips Stop-hook delivery", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const socketPath = `${runtimeDirectory}/claude-code.sock`;
  let connectionCount = 0;
  const server = createServer(() => {
    connectionCount++;
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const payload = stopPayload();
    const environment = isolatedEnvironment({
      XDG_RUNTIME_DIR: runtimeDirectory,
      CLAUDE_CODE_MESSAGING_SOCKET: `uds:${socketPath}`,
      CLAUDE_CODE_MESSAGING_TOKEN: "dedupe-stop-token",
    });
    writeDedupeMarker(payload.session_id, environment);

    const result = await runHook(JSON.stringify(payload), environment);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(connectionCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("stale dedupe marker is reclaimed before Stop-hook delivery", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = stopPayload({ session_id: "thread-stale-marker-delivery" });
  const environment = { XDG_RUNTIME_DIR: runtimeDirectory };
  const markerPath = dedupeMarkerPath(payload.session_id, environment);
  const token = "stale-marker-delivery-token";
  try {
    writeDedupeMarker(payload.session_id, environment);
    writeFileSync(markerPath, `stop:${Date.now() + 3_600_000}`, { mode: 0o600 });

    const { frames } = await runDeliveredHook({
      input: JSON.stringify(payload),
      environment,
      token,
    });
    assertDeliveredFrames(frames, token, envelopeFromStopPayload(payload));
    assert.strictEqual(hasFreshDedupeMarker(payload.session_id, environment), true);
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Stop-hook delivery without a dedupe marker is unchanged", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = stopPayload();
  const token = "no-dedupe-marker-token";
  try {
    const { frames } = await runDeliveredHook({
      input: JSON.stringify(payload),
      environment: { XDG_RUNTIME_DIR: runtimeDirectory },
      token,
    });

    assertDeliveredFrames(frames, token, envelopeFromStopPayload(payload));
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("failed argv --from delivery removes its dedupe marker", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = notifyPayload({ "thread-id": "thread-failed-delivery" });
  const threadID = payload["thread-id"];
  const environment = isolatedEnvironment({
    XDG_RUNTIME_DIR: runtimeDirectory,
    CLAUDE_CODE_MESSAGING_SOCKET: `uds:${runtimeDirectory}/unreachable.sock`,
    CLAUDE_CODE_MESSAGING_TOKEN: "failed-delivery-token",
  });
  try {
    const result = await runHook("", environment, {
      cliArgs: ["--from", "builder", JSON.stringify(payload)],
      closeStdin: false,
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.match(result.stderr, /^codex-claude-notify: notify Claude Code: .+\n$/);
    assert.strictEqual(hasFreshDedupeMarker(threadID, environment), false);

    const stopHookPayload = stopPayload({ session_id: threadID });
    const token = "post-failure-stop-token";
    const { frames } = await runDeliveredHook({
      input: JSON.stringify(stopHookPayload),
      environment: { XDG_RUNTIME_DIR: runtimeDirectory },
      token,
    });
    assertDeliveredFrames(frames, token, envelopeFromStopPayload(stopHookPayload));
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("fresh dedupe marker suppresses only one Stop-hook delivery", async () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const payload = notifyPayload({ "thread-id": "thread-single-stop-skip" });
  const threadID = payload["thread-id"];
  const token = "single-stop-skip-token";
  const socketPath = `${runtimeDirectory}/claude-code.sock`;
  let connectionCount = 0;
  const server = createServer(() => {
    connectionCount++;
  });
  try {
    await runDeliveredHook({
      cliArgs: ["--from", "builder", JSON.stringify(payload)],
      environment: { XDG_RUNTIME_DIR: runtimeDirectory },
      token,
    });
    assert.strictEqual(
      hasFreshDedupeMarker(threadID, { XDG_RUNTIME_DIR: runtimeDirectory }),
      true,
    );

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const stopHookPayload = stopPayload({ session_id: threadID });
    const stopEnvironment = isolatedEnvironment({
      XDG_RUNTIME_DIR: runtimeDirectory,
      CLAUDE_CODE_MESSAGING_SOCKET: `uds:${socketPath}`,
      CLAUDE_CODE_MESSAGING_TOKEN: "single-stop-skip-token",
    });
    const firstResult = await runHook(JSON.stringify(stopHookPayload), stopEnvironment);
    assert.strictEqual(firstResult.code, 0);
    assert.strictEqual(firstResult.signal, null);
    assert.strictEqual(firstResult.stdout, "");
    assert.strictEqual(firstResult.stderr, "");
    assert.strictEqual(connectionCount, 0);
    assert.strictEqual(hasFreshDedupeMarker(threadID, stopEnvironment), false);

    const secondToken = "second-stop-delivery-token";
    const { frames } = await runDeliveredHook({
      input: JSON.stringify(stopHookPayload),
      environment: { XDG_RUNTIME_DIR: runtimeDirectory },
      token: secondToken,
    });
    assertDeliveredFrames(frames, secondToken, envelopeFromStopPayload(stopHookPayload));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("future-dated dedupe marker is stale and pruned", () => {
  const runtimeDirectory = mkdtempSync(`${tmpdir()}/codex-claude-notify-test-`);
  const environment = { XDG_RUNTIME_DIR: runtimeDirectory };
  const threadID = "thread-future-marker";
  const markerPath = dedupeMarkerPath(threadID, environment);
  try {
    writeDedupeMarker(threadID, environment);
    writeFileSync(markerPath, String(Date.now() + 3_600_000), { mode: 0o600 });

    assert.strictEqual(hasFreshDedupeMarker(threadID, environment), false);
    writeDedupeMarker("thread-prune-trigger", environment);
    assert.strictEqual(existsSync(markerPath), false);
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("notification message", () => {
  const actual = envelopeFromStopPayload(stopPayload());
  const expected =
    '<teammate-message teammate_id="codex" summary="[Codex turn complete] Implemented the requested change.">\n' +
    "[Codex turn complete] Implemented the requested change.\n\n" +
    "(codex thread thread-123, cwd /workspace/project)\n" +
    "</teammate-message>";
  assert.strictEqual(actual, expected);
});

test("envelopeFromStopPayload applies teammate name - plain name", () => {
  const envelope = envelopeFromStopPayload(stopPayload(), "builder");
  assert.match(envelope, /^<teammate-message teammate_id="codex:builder" /);
});

test("envelopeFromStopPayload applies teammate name - quote escaping", () => {
  const envelope = envelopeFromStopPayload(stopPayload(), 'release "captain"');
  assert.match(
    envelope,
    /^<teammate-message teammate_id="codex:release &quot;captain&quot;" /,
  );
});

test("envelopeFromStopPayload applies teammate name - whitespace normalization", () => {
  const envelope = envelopeFromStopPayload(stopPayload(), "  release\t\u0085captain\n  ");
  assert.match(envelope, /^<teammate-message teammate_id="codex:release captain" /);
});

test("envelopeFromStopPayload applies teammate name - max length clamp", () => {
  const teammateName = "a".repeat(65);
  const envelope = envelopeFromStopPayload(stopPayload(), teammateName);
  assert.match(
    envelope,
    new RegExp(`^<teammate-message teammate_id="codex:${"a".repeat(64)}" `),
  );
  assert.strictEqual(normalizeTeammateName(teammateName), "a".repeat(64));
});

describe("notification message uses teammate id from flag", () => {
  const cases = [
    {
      name: "plain name",
      teammateName: "reviewer",
      expected: 'teammate_id="codex:reviewer"',
    },
    {
      name: "escaped quote",
      teammateName: 'foo"bar',
      expected: 'teammate_id="codex:foo&quot;bar"',
    },
    {
      name: "normalized whitespace",
      teammateName: "  multi   word   name  ",
      expected: 'teammate_id="codex:multi word name"',
    },
    {
      name: "maximum name length",
      teammateName: "a".repeat(100),
      expected: `teammate_id="codex:${"a".repeat(maximumTeammateNameRunes)}"`,
    },
  ];

  test("all cases are registered", () => assert.strictEqual(cases.length, 4));

  for (const { name, teammateName, expected } of cases) {
    test(name, () => {
      const envelope = buildEnvelope({
        lastAssistantMessage: "ж".repeat(maximumMessageBytes),
        teammateName,
      });
      assert.ok(envelope.includes(expected));
      assert.ok(Buffer.byteLength(envelope, "utf8") <= maximumMessageBytes);
    });
  }
});

test("notification message includes thread metadata", () => {
  assert.strictEqual(notificationMetadata(" thread-only ", ""), "(codex thread thread-only)");
  assert.match(
    buildEnvelope({ threadID: "thread-only", lastAssistantMessage: "done" }),
    /\n\n\(codex thread thread-only\)\n<\/teammate-message>$/,
  );
});

test("notification message includes cwd metadata", () => {
  assert.strictEqual(notificationMetadata("", " /workspace "), "(codex cwd /workspace)");
  assert.match(
    buildEnvelope({ cwd: "/workspace", lastAssistantMessage: "done" }),
    /\n\n\(codex cwd \/workspace\)\n<\/teammate-message>$/,
  );
});

test("notification message includes thread and cwd metadata", () => {
  assert.strictEqual(
    notificationMetadata(" thread-id ", " /workspace "),
    "(codex thread thread-id, cwd /workspace)",
  );
  assert.match(
    buildEnvelope({ threadID: "thread-id", cwd: "/workspace", lastAssistantMessage: "done" }),
    /\n\n\(codex thread thread-id, cwd \/workspace\)\n<\/teammate-message>$/,
  );
});

test("notification metadata trims long input in linear time", () => {
  const threadID = "a" + " ".repeat(80000) + "b";
  const startedAt = performance.now();
  const metadata = notificationMetadata(threadID, "");
  const duration = performance.now() - startedAt;

  assert.strictEqual(metadata, `(codex thread ${threadID})`);
  assert.ok(duration < 200, `notificationMetadata took ${duration.toFixed(2)}ms`);
});

test("notification message omits empty metadata", () => {
  assert.strictEqual(notificationMetadata(" \t", "\n"), "");
  assert.strictEqual(
    buildEnvelope({ lastAssistantMessage: "done" }),
    '<teammate-message teammate_id="codex" summary="[Codex turn complete] done">\n' +
      "[Codex turn complete] done\n</teammate-message>",
  );
});

test("notification message ignores unknown events", () => {
  assert.strictEqual(
    envelopeFromStopPayload(stopPayload({ hook_event_name: "SubagentStop" })),
    null,
  );
  assert.strictEqual(envelopeFromStopPayload({}), null);
});

test("notification message truncates at UTF-8 boundary", () => {
  const envelope = buildEnvelope({ lastAssistantMessage: "é".repeat(40000) });
  assert.ok(envelope.includes("[notification truncated]"));
  assert.strictEqual(Buffer.from(envelope, "utf8").toString("utf8"), envelope);
  assert.ok(!envelope.includes("\uFFFD"));
  assert.ok(Buffer.byteLength(envelope, "utf8") <= maximumMessageBytes);
  assert.ok(
    envelope.startsWith(teammateMessageOpenTagPrefix + "codex" + teammateMessageIDSuffix),
  );
  assert.ok(envelope.endsWith("</teammate-message>"));
});

test("notification message truncates assistant message before metadata", () => {
  const envelope = buildEnvelope({
    threadID: "thread-123",
    cwd: "/workspace/project",
    lastAssistantMessage: "x".repeat(maximumMessageBytes),
  });
  assert.ok(
    envelope.endsWith(
      "\n\n[notification truncated]\n\n" +
        "(codex thread thread-123, cwd /workspace/project)\n" +
        "</teammate-message>",
    ),
  );
  assert.ok(Buffer.byteLength(envelope, "utf8") <= maximumMessageBytes);
});

test("notification message escapes summary", () => {
  const body = 'A & <tag> > "quote"';
  assert.strictEqual(notificationSummary(body), "A &amp; &lt;tag&gt; &gt; &quot;quote&quot;");
  assert.strictEqual(escapeXMLAttribute('&<>"'), "&amp;&lt;&gt;&quot;");
  assert.match(
    buildEnvelope({ lastAssistantMessage: body }),
    /summary="\[Codex turn complete\] A &amp; &lt;tag&gt; &gt; &quot;quote&quot;"/,
  );
});

test("notification message neutralizes closing tag variants", () => {
  const envelope = buildEnvelope({
    lastAssistantMessage:
      "before </teammate-message> </teammate-message > </teammate-message\t> </teammate-message\n> after",
  });
  assert.strictEqual(envelope.split("</teammate-message>").length - 1, 1);
  assert.ok(
    envelope.includes(
      "before &lt;/teammate-message&gt; &lt;/teammate-message&gt; " +
        "&lt;/teammate-message&gt; &lt;/teammate-message&gt; after\n</teammate-message>",
    ),
  );
});

test("notification message preserves metadata when escaped text is truncated", () => {
  const threadID = `thread-${"t".repeat(1024)}`;
  const cwd = `/workspace/${"c".repeat(1024)}`;
  const metadata = notificationMetadata(threadID, cwd);
  const envelope = buildEnvelope({
    threadID,
    cwd,
    lastAssistantMessage: "&lt;/teammate-message&gt;".repeat(4000),
  });

  assert.ok(envelope.includes("[notification truncated]"));
  assert.ok(envelope.endsWith(`\n\n${metadata}\n</teammate-message>`));
  assert.ok(Buffer.byteLength(envelope, "utf8") <= maximumMessageBytes);
  assert.ok(Buffer.byteLength(envelope, "utf8") > maximumMessageBytes - 2048);
  assert.strictEqual(envelope.split("</teammate-message>").length - 1, 1);
});

test("notification message preserves metadata when raw closing tags expand past truncation", () => {
  const threadID = `thread-${"t".repeat(1024)}`;
  const cwd = `/workspace/${"c".repeat(1024)}`;
  const metadata = notificationMetadata(threadID, cwd);
  const envelope = buildEnvelope({
    threadID,
    cwd,
    lastAssistantMessage: "</teammate-message>".repeat(10000),
  });

  assert.ok(Buffer.byteLength(envelope, "utf8") <= maximumMessageBytes);
  assert.ok(envelope.includes("[notification truncated]"));
  assert.strictEqual(envelope.split("</teammate-message>").length - 1, 1);
  assert.ok(envelope.endsWith(`\n\n${metadata}\n</teammate-message>`));
});

test("notification message drops a body that cannot fit the truncation suffix", () => {
  const truncationSuffixBytes = Buffer.byteLength("\n\n[notification truncated]", "utf8");
  const openTag = teammateMessageOpenTagPrefix + "codex" + teammateMessageIDSuffix;
  const envelopeReserve =
    Buffer.byteLength(openTag, "utf8") +
    maximumSummaryEscapedBytes +
    Buffer.byteLength(teammateMessageOpenTagSuffix, "utf8") +
    Buffer.byteLength(teammateMessageCloseTag, "utf8");
  const bodyLimit = maximumMessageBytes - envelopeReserve;
  const messageLimit = Math.floor(truncationSuffixBytes / 2);
  const metadataOverhead = Buffer.byteLength("\n\n(codex thread )", "utf8");
  const threadID = "t".repeat(bodyLimit - messageLimit - metadataOverhead);
  const metadata = notificationMetadata(threadID, "");
  let envelope;
  assert.doesNotThrow(() => {
    envelope = buildEnvelope({
      threadID,
      lastAssistantMessage: "m".repeat(maximumMessageBytes),
    });
  });

  assert.ok(messageLimit > 0 && messageLimit <= truncationSuffixBytes);
  assert.ok(Buffer.byteLength(envelope, "utf8") <= maximumMessageBytes);
  assert.ok(envelope.endsWith(`\n\n${metadata}\n</teammate-message>`));
});

test("notification message neutralizes malicious metadata", () => {
  const envelope = buildEnvelope({
    threadID: "thread </teammate-message >",
    cwd: "/workspace</teammate-message\t>",
    lastAssistantMessage: "done",
  });

  assert.ok(
    envelope.includes(
      "(codex thread thread &lt;/teammate-message&gt;, " +
        "cwd /workspace&lt;/teammate-message&gt;)",
    ),
  );
  assert.strictEqual(envelope.split("</teammate-message>").length - 1, 1);
});

describe("notification envelope contains exactly one literal closing tag", () => {
  const cases = [
    { name: "normal message", options: { lastAssistantMessage: "done" } },
    {
      name: "oversized message",
      options: { lastAssistantMessage: "x".repeat(maximumMessageBytes * 2) },
    },
    {
      name: "malicious metadata",
      options: { threadID: "</teammate-message>", lastAssistantMessage: "done" },
    },
    {
      name: "malicious message",
      options: { lastAssistantMessage: "before </teammate-message\n> after" },
    },
  ];

  test("all cases are registered", () => assert.strictEqual(cases.length, 4));

  for (const { name, options } of cases) {
    test(name, () => {
      const envelope = buildEnvelope(options);
      assert.strictEqual(envelope.split("</teammate-message>").length - 1, 1);
      assert.ok(Buffer.byteLength(envelope, "utf8") <= maximumMessageBytes);
    });
  }
});

test("notification message wraps empty fallback", () => {
  const expectedBody =
    "[Codex turn complete] The Codex turn finished without a final assistant message.";
  for (const lastAssistantMessage of ["", " \t\n\u0085 "]) {
    const envelope = buildEnvelope({ lastAssistantMessage });
    assert.strictEqual(
      envelope,
      `<teammate-message teammate_id="codex" summary="${expectedBody}">\n` +
        `${expectedBody}\n</teammate-message>`,
    );
  }
});

test("multibyte and surrogate-pair truncation respects the byte limit", () => {
  const supplementaryCharacter = "\u{10400}";
  const exact = truncateUTF8("a".repeat(70) + supplementaryCharacter.repeat(10), 100);
  assert.strictEqual(Buffer.byteLength(exact, "utf8"), 100);
  assert.strictEqual(Buffer.from(exact, "utf8").toString("utf8"), exact);

  const splitBoundary = truncateUTF8("a".repeat(70) + supplementaryCharacter.repeat(10), 101);
  assert.strictEqual(Buffer.byteLength(splitBoundary, "utf8"), 100);
  assert.strictEqual(Buffer.from(splitBoundary, "utf8").toString("utf8"), splitBoundary);
  assert.ok(!splitBoundary.includes("\uFFFD"));

  const envelope = buildEnvelope({
    lastAssistantMessage: supplementaryCharacter.repeat(maximumMessageBytes),
  });
  assert.strictEqual(Buffer.from(envelope, "utf8").toString("utf8"), envelope);
  assert.ok(!envelope.includes("\uFFFD"));
  assert.ok(envelope.includes("[notification truncated]"));
  assert.ok(Buffer.byteLength(envelope, "utf8") <= maximumMessageBytes);
});

test("socket notifier sends Claude Code frames", async () => {
  const socketPath = `${tmpdir()}/ccn-${process.pid}-${socketSequence++}.sock`;
  const server = createServer();
  const framesReceived = new Promise((resolve, reject) => {
    server.once("connection", (socket) => {
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        received += chunk;
      });
      socket.once("error", reject);
      socket.once("end", () => resolve(received));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const envelope = buildEnvelope({ lastAssistantMessage: "socket delivery" });
  try {
    const notifier = notifierFromEnvironment({
      CLAUDE_CODE_MESSAGING_SOCKET: `uds:${socketPath}`,
      CLAUDE_CODE_MESSAGING_TOKEN: 'token-"exact"',
    });
    await sendMessage(envelope, notifier);
    const received = await framesReceived;
    const lines = received.split("\n");
    assert.strictEqual(lines.at(-1), "");
    assert.strictEqual(lines.length, 3);
    assert.deepStrictEqual(JSON.parse(lines[0]), {
      type: "auth",
      token: 'token-"exact"',
    });
    assert.deepStrictEqual(JSON.parse(lines[1]), {
      type: "user",
      message: { role: "user", content: envelope },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("socket notifier times out while connecting", async () => {
  const socket = new EventEmitter();
  let destroyCount = 0;
  socket.write = () => {};
  socket.end = () => {};
  socket.destroy = () => {
    destroyCount++;
  };

  await assert.rejects(
    sendMessage(
      buildEnvelope({ lastAssistantMessage: "connect timeout" }),
      {
        socketPath: "/irrelevant/for/this/test",
        token: "t",
        timeout: 50,
      },
      { connect: () => socket },
    ),
    (error) => {
      assert.match(error.message, /connect to Claude Code messaging socket/);
      assert.match(error.message, /timeout/i);
      return true;
    },
  );
  assert.strictEqual(destroyCount, 1);
});

test("socket notifier times out while writing", async () => {
  const socket = new EventEmitter();
  let destroyCount = 0;
  let writeCount = 0;
  socket.write = () => {
    writeCount++;
  };
  socket.end = () => {};
  socket.destroy = () => {
    destroyCount++;
  };

  await assert.rejects(
    sendMessage(
      buildEnvelope({ lastAssistantMessage: "write timeout" }),
      {
        socketPath: "/irrelevant/for/this/test",
        token: "t",
        timeout: 50,
      },
      {
        connect: () => {
          queueMicrotask(() => socket.emit("connect"));
          return socket;
        },
      },
    ),
    (error) => {
      assert.match(error.message, /write Claude Code messaging frame/);
      assert.match(error.message, /timeout/i);
      return true;
    },
  );
  assert.strictEqual(destroyCount, 1);
  assert.strictEqual(writeCount, 1);
});

describe("zero arguments select stdin mode across script path variants", () => {
  const variants = [
    { name: "plain script path", scriptPath: () => notifyScriptPath },
    {
      name: "copied hooks directory under a path with a space",
      scriptPath: (variantRoot) => {
        const copiedHooksDirectoryPath = `${variantRoot}/hooks with space`;
        cpSync(notifyHooksDirectoryPath, copiedHooksDirectoryPath, { recursive: true });
        return `${copiedHooksDirectoryPath}/notify.mjs`;
      },
    },
    {
      name: "symlink to the real script",
      scriptPath: (variantRoot) => {
        const symlinkPath = `${variantRoot}/notify-link.mjs`;
        symlinkSync(notifyScriptPath, symlinkPath);
        return symlinkPath;
      },
    },
  ];
  const token = 'stdin-token-"exact"';

  test("all cases are registered", () => assert.strictEqual(variants.length, 3));

  for (const variant of variants) {
    test(
      variant.name,
      async () => {
        const variantRoot = mkdtempSync(`${tmpdir()}/ccn-script-variants-`);
        const variantPayload = stopPayload({
          session_id: `thread-stdin-variant-${process.pid}-${socketSequence++}`,
          last_assistant_message: "Delivered from spawned stdin mode.",
        });
        const variantExpectedEnvelope = envelopeFromStopPayload(variantPayload);
        try {
          const scriptPath = variant.scriptPath(variantRoot);
          const { frames } = await runDeliveredHook({
            input: JSON.stringify(variantPayload),
            scriptPath,
            token,
          });
          assertDeliveredFrames(frames, token, variantExpectedEnvelope);
        } finally {
          rmSync(variantRoot, { recursive: true, force: true });
        }
      },
      20000,
    );
  }
});

test("importing notify does not install process-wide rejection handlers", async () => {
  const helperRoot = mkdtempSync(`${tmpdir()}/ccn-import-handler-`);
  try {
    const helperScriptPath = `${helperRoot}/import-notify.mjs`;
    const notifyModuleURL = new URL(
      "../plugins/codex-claude-notify/hooks/notify.mjs",
      import.meta.url,
    );
    writeFileSync(
      helperScriptPath,
      `import ${JSON.stringify(notifyModuleURL.href)};\nPromise.reject(new Error("boom"));\n`,
    );

    const result = await runHook("", isolatedEnvironment(), { scriptPath: helperScriptPath });
    assert.notStrictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.match(result.stderr, /boom/);
    assert.ok(!result.stderr.startsWith("codex-claude-notify: "));
  } finally {
    rmSync(helperRoot, { recursive: true, force: true });
  }
});

test("fatal handler exits with a broken stderr pipe", async () => {
  const helperRoot = mkdtempSync(`${tmpdir()}/ccn-fatal-handler-`);
  try {
    const helperScriptPath = `${helperRoot}/force-fatal.cjs`;
    writeFileSync(
      helperScriptPath,
      [
        "const watch = (eventName) => {",
        '  if (eventName !== "uncaughtException") {',
        "    return;",
        "  }",
        '  process.off("newListener", watch);',
        "  setImmediate(() => {",
        '    throw new Error("forced fatal error");',
        "  });",
        "};",
        'process.on("newListener", watch);',
        "",
      ].join("\n"),
    );

    const startedAt = performance.now();
    const result = await runHook("", isolatedEnvironment(), {
      closeStdin: false,
      closeStderr: true,
      nodeArgs: ["--require", helperScriptPath],
      timeoutMilliseconds: 2500,
    });
    const duration = performance.now() - startedAt;

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.ok(duration < 2000, `fatal handler took ${duration.toFixed(2)}ms to exit`);
  } finally {
    rmSync(helperRoot, { recursive: true, force: true });
  }
}, 5000);

test("notifier from environment", () => {
  assert.deepStrictEqual(
    notifierFromEnvironment({
      CLAUDE_CODE_MESSAGING_SOCKET: "uds:/tmp/claude-code.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "session-token",
    }),
    {
      socketPath: "/tmp/claude-code.sock",
      token: "session-token",
      timeout: 3000,
    },
  );
  assert.deepStrictEqual(
    notifierFromEnvironment({
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/claude-code.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "session-token",
    }),
    {
      socketPath: "/tmp/claude-code.sock",
      token: "session-token",
      timeout: 3000,
    },
  );
});

test("notifier from environment requires session values", () => {
  assert.strictEqual(notifierFromEnvironment({}), null);
  assert.strictEqual(
    notifierFromEnvironment({
      CLAUDE_CODE_MESSAGING_SOCKET: "",
      CLAUDE_CODE_MESSAGING_TOKEN: "",
    }),
    null,
  );
  assert.throws(
    () => notifierFromEnvironment({ CLAUDE_CODE_MESSAGING_TOKEN: "token" }),
    /CLAUDE_CODE_MESSAGING_SOCKET is not set/,
  );
  assert.throws(
    () => notifierFromEnvironment({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/socket" }),
    /CLAUDE_CODE_MESSAGING_TOKEN is not set/,
  );
  assert.throws(
    () =>
      notifierFromEnvironment({
        CLAUDE_CODE_MESSAGING_SOCKET: "relative/socket",
        CLAUDE_CODE_MESSAGING_TOKEN: "token",
      }),
    /Claude Code messaging socket path must be absolute/,
  );
});

test("socket notifier rejects empty and oversized messages", async () => {
  const notifier = { socketPath: "/unused", token: "token", timeout: 3000 };
  await assert.rejects(sendMessage("", notifier), /message must not be empty/);
  await assert.rejects(
    sendMessage("x".repeat(maximumMessageBytes + 1), notifier),
    new RegExp(`message exceeds ${maximumMessageBytes}-byte limit`),
  );
});

test(
  "stdin payload larger than 70000 bytes is drained when messaging variables are absent",
  async () => {
    const input = JSON.stringify(
      stopPayload({ last_assistant_message: "x".repeat(80000) }),
    );
    assert.ok(Buffer.byteLength(input, "utf8") > 70000);
    const result = await runHook(input, isolatedEnvironment());
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  },
  5000,
);

test(
  "oversized stdin payload is drained and skipped",
  async () => {
    const input = "x".repeat(9 * 1024 * 1024);
    assert.ok(Buffer.byteLength(input, "utf8") > maximumStdinBytes);
    const result = await runHook(input, isolatedEnvironment());
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(
      result.stderr,
      `codex-claude-notify: stdin payload exceeds ${maximumStdinBytes} bytes; notification skipped\n`,
    );
  },
  6000,
);

test(
  "disabled hook drains stdin and exits silently",
  async () => {
    const input = JSON.stringify(stopPayload({ last_assistant_message: "x".repeat(80000) }));
    const result = await runHook(
      input,
      isolatedEnvironment({
        CODEX_CLAUDE_NOTIFY_DISABLE: "1",
        CLAUDE_CODE_MESSAGING_TOKEN: "token-without-socket",
      }),
    );
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(result.stderr, "");
  },
  5000,
);

test("disabled argv mode exits silently without reading stdin", async () => {
  const result = await runHook(
    "",
    isolatedEnvironment({
      CODEX_CLAUDE_NOTIFY_DISABLE: "1",
      CLAUDE_CODE_MESSAGING_TOKEN: "token-without-socket",
    }),
    {
      cliArgs: [JSON.stringify(notifyPayload())],
      closeStdin: false,
    },
  );
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("malformed stdin exits silently", async () => {
  const result = await runHook("{not-json", isolatedEnvironment());
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});

test("malformed stdin diagnoses an incomplete messaging environment", async () => {
  const result = await runHook(
    "{not-json",
    isolatedEnvironment({ CLAUDE_CODE_MESSAGING_TOKEN: "token-without-socket" }),
  );
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(
    result.stderr,
    "codex-claude-notify: CLAUDE_CODE_MESSAGING_SOCKET is not set\n",
  );
});

test(
  "stdin read deadline exits when stdin remains open",
  async () => {
    const startedAt = performance.now();
    const result = await runHook(
      "",
      isolatedEnvironment({ CODEX_CLAUDE_NOTIFY_STDIN_TIMEOUT_MS: "500" }),
      { closeStdin: false },
    );
    const duration = performance.now() - startedAt;

    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.signal, null);
    assert.strictEqual(result.stdout, "");
    assert.strictEqual(
      result.stderr,
      "codex-claude-notify: stdin read timed out after 500ms; notification skipped\n",
    );
    assert.ok(duration < 2000, `notify hook took ${duration.toFixed(2)}ms to time out`);
  },
  6000,
);

test("stdin timeout clamps huge values and defaults invalid values", () => {
  assert.strictEqual(
    stdinTimeoutFromEnvironment({ CODEX_CLAUDE_NOTIFY_STDIN_TIMEOUT_MS: "99999999999999" }),
    2_147_483_647,
  );
  for (const value of ["0", "-5", "abc", ""]) {
    assert.strictEqual(
      stdinTimeoutFromEnvironment({ CODEX_CLAUDE_NOTIFY_STDIN_TIMEOUT_MS: value }),
      30000,
    );
  }
});

describe("argv mode ignores invalid notification JSON without messaging environment", () => {
  const cases = [["not-json"], ["--from", "name", "not-json"]];

  test("all cases are registered", () => assert.strictEqual(cases.length, 2));

  for (const cliArgs of cases) {
    test(JSON.stringify(cliArgs), async () => {
      const result = await runHook("", isolatedEnvironment(), {
        cliArgs,
        closeStdin: false,
      });
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, "");
    });
  }
});

test("argv mode diagnoses invalid notification JSON with messaging environment", async () => {
  const result = await runHook(
    "",
    isolatedEnvironment({
      CLAUDE_CODE_MESSAGING_SOCKET: `${tmpdir()}/ccn-${process.pid}-${socketSequence++}.sock`,
      CLAUDE_CODE_MESSAGING_TOKEN: "session-token",
    }),
    { cliArgs: ["not-json"], closeStdin: false },
  );
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout, "");
  assert.match(result.stderr, /^codex-claude-notify: decode Codex notification: .+\n$/);
});

test("unreachable messaging socket produces one diagnostic", async () => {
  const result = await runHook(
    JSON.stringify(stopPayload({ session_id: `thread-unreachable-${process.pid}` })),
    isolatedEnvironment({
      CLAUDE_CODE_MESSAGING_SOCKET: `${tmpdir()}/ccn-${process.pid}-${socketSequence++}.sock`,
      CLAUDE_CODE_MESSAGING_TOKEN: "session-token",
    }),
  );
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout, "");
  assert.match(
    result.stderr,
    /^codex-claude-notify: notify Claude Code: connect to Claude Code messaging socket: .+\n$/,
  );
});

test("argv mode ignores unknown leading arguments", async () => {
  const payload = notifyPayload({
    "thread-id": `thread-unknown-leading-${process.pid}`,
    "last-assistant-message": "Unknown leading arguments were ignored.",
  });
  const expectedEnvelope = buildEnvelope({
    threadID: payload["thread-id"],
    cwd: payload.cwd,
    lastAssistantMessage: payload["last-assistant-message"],
  });
  const token = "unknown-leading-token";
  const { frames } = await runDeliveredHook({
    cliArgs: ["--verbose", "true", JSON.stringify(payload)],
    token,
  });
  assertDeliveredFrames(frames, token, expectedEnvelope);
  const deliveredEnvelope = frames[1].message.content;
  assert.ok(deliveredEnvelope.includes('teammate_id="codex"'));
  assert.ok(!deliveredEnvelope.includes('teammate_id="codex:'));
});

test("argv mode ignores a dangling from flag", async () => {
  const payload = notifyPayload({
    "thread-id": `thread-dangling-from-${process.pid}`,
    "last-assistant-message": "The dangling flag was ignored.",
  });
  const expectedEnvelope = buildEnvelope({
    threadID: payload["thread-id"],
    cwd: payload.cwd,
    lastAssistantMessage: payload["last-assistant-message"],
  });
  const token = "dangling-from-token";
  const { frames } = await runDeliveredHook({
    cliArgs: ["--from", JSON.stringify(payload)],
    token,
  });
  assertDeliveredFrames(frames, token, expectedEnvelope);
  const deliveredEnvelope = frames[1].message.content;
  assert.ok(deliveredEnvelope.includes('teammate_id="codex"'));
  assert.ok(!deliveredEnvelope.includes('teammate_id="codex:'));
});

test("argv mode uses teammate id from --from flag", async () => {
  const payload = notifyPayload({
    "thread-id": `thread-from-flag-${process.pid}`,
    "last-assistant-message": "The --from flag supplied the teammate id.",
  });
  const expectedEnvelope = buildEnvelope({
    threadID: payload["thread-id"],
    cwd: payload.cwd,
    lastAssistantMessage: payload["last-assistant-message"],
    teammateName: "flag-name",
  });
  const token = "from-flag-token";
  const { frames } = await runDeliveredHook({
    cliArgs: ["--from", "flag-name", JSON.stringify(payload)],
    token,
  });
  assertDeliveredFrames(frames, token, expectedEnvelope);
});

test("argv mode uses teammate id from CODEX_CLAUDE_NOTIFY_FROM env when no flag is given", async () => {
  const payload = notifyPayload({
    "thread-id": `thread-from-environment-${process.pid}`,
    "last-assistant-message": "The environment supplied the teammate id.",
  });
  const expectedEnvelope = buildEnvelope({
    threadID: payload["thread-id"],
    cwd: payload.cwd,
    lastAssistantMessage: payload["last-assistant-message"],
    teammateName: "env-name",
  });
  const token = "from-environment-token";
  const { frames } = await runDeliveredHook({
    cliArgs: [JSON.stringify(payload)],
    environment: { CODEX_CLAUDE_NOTIFY_FROM: "env-name" },
    token,
  });
  assertDeliveredFrames(frames, token, expectedEnvelope);
});

test("argv mode prefers --from flag over CODEX_CLAUDE_NOTIFY_FROM env", async () => {
  const payload = notifyPayload({
    "thread-id": `thread-from-precedence-${process.pid}`,
    "last-assistant-message": "The flag took precedence over the environment.",
  });
  const expectedEnvelope = buildEnvelope({
    threadID: payload["thread-id"],
    cwd: payload.cwd,
    lastAssistantMessage: payload["last-assistant-message"],
    teammateName: "flag-name",
  });
  const token = "from-precedence-token";
  const { frames } = await runDeliveredHook({
    cliArgs: ["--from", "flag-name", JSON.stringify(payload)],
    environment: { CODEX_CLAUDE_NOTIFY_FROM: "env-name" },
    token,
  });
  assertDeliveredFrames(frames, token, expectedEnvelope);
});

test("argv mode ignores unknown events", async () => {
  const result = await runHook(
    "",
    isolatedEnvironment({
      CLAUDE_CODE_MESSAGING_SOCKET: `${tmpdir()}/ccn-${process.pid}-${socketSequence++}.sock`,
      CLAUDE_CODE_MESSAGING_TOKEN: "session-token",
    }),
    {
      cliArgs: [JSON.stringify(notifyPayload({ type: "approval-requested" }))],
      closeStdin: false,
    },
  );
  assert.strictEqual(result.code, 0);
  assert.strictEqual(result.signal, null);
  assert.strictEqual(result.stdout, "");
  assert.strictEqual(result.stderr, "");
});
