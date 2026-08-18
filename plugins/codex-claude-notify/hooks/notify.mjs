#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

export const messagePrefix = "[Codex turn complete] ";
export const teammateMessageOpenTagPrefix = '<teammate-message teammate_id="';
export const teammateMessageIDSuffix = '" summary="';
export const teammateMessageOpenTagSuffix = '">\n';
export const teammateMessageCloseTag = "\n</teammate-message>";
export const maximumSummaryRunes = 200;
export const maximumSummaryEscapedBytes = maximumSummaryRunes * 6;
export const maximumTeammateNameRunes = 64;
export const maximumMessageBytes = 64 * 1024;
export const maximumStdinBytes = 8 * 1024 * 1024;
export const defaultSocketTimeout = 3000;
const defaultStdinTimeout = 30000;
const maximumStdinTimeout = 2_147_483_647;
const truncationSuffix = "\n\n[notification truncated]";
const truncationSuffixBytes = Buffer.byteLength(truncationSuffix, "utf8");
const unicodeWhitespacePattern = /^\p{White_Space}$/u;
const closingTeammateMessageTagPattern = /<\/teammate-message[\t\n\r ]*>/g;

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function trimUnicodeWhitespace(value) {
  let start = 0;
  let end = value.length;

  while (start < end) {
    const codePoint = String.fromCodePoint(value.codePointAt(start));
    if (!unicodeWhitespacePattern.test(codePoint)) {
      break;
    }
    start += codePoint.length;
  }

  while (start < end) {
    let codePointStart = end - 1;
    const trailingCodeUnit = value.charCodeAt(codePointStart);
    if (trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff && codePointStart > start) {
      const leadingCodeUnit = value.charCodeAt(codePointStart - 1);
      if (leadingCodeUnit >= 0xd800 && leadingCodeUnit <= 0xdbff) {
        codePointStart--;
      }
    }
    if (!unicodeWhitespacePattern.test(value.slice(codePointStart, end))) {
      break;
    }
    end = codePointStart;
  }

  return value.slice(start, end);
}

function neutralizeClosingTeammateMessageTags(value) {
  return value.replace(closingTeammateMessageTagPattern, "&lt;/teammate-message&gt;");
}

function collapseUnicodeWhitespace(value) {
  return value.split(/\p{White_Space}+/u).filter(Boolean).join(" ");
}

function clampCodePoints(value, limit) {
  const codePoints = [...value];
  return codePoints.length > limit ? codePoints.slice(0, limit).join("") : value;
}

export function normalizeTeammateName(value) {
  return clampCodePoints(collapseUnicodeWhitespace(stringValue(value)), maximumTeammateNameRunes);
}

export function escapeXMLAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function notificationSummary(body) {
  let summary = "";
  for (const bodyLine of body.split("\n")) {
    const line = trimUnicodeWhitespace(bodyLine);
    if (line !== "") {
      summary = collapseUnicodeWhitespace(line);
      break;
    }
  }

  return escapeXMLAttribute(clampCodePoints(summary, maximumSummaryRunes));
}

export function notificationMetadata(threadID, cwd) {
  const normalizedThreadID = trimUnicodeWhitespace(stringValue(threadID));
  const normalizedCWD = trimUnicodeWhitespace(stringValue(cwd));

  if (normalizedThreadID !== "" && normalizedCWD !== "") {
    return `(codex thread ${normalizedThreadID}, cwd ${normalizedCWD})`;
  }
  if (normalizedThreadID !== "") {
    return `(codex thread ${normalizedThreadID})`;
  }
  if (normalizedCWD !== "") {
    return `(codex cwd ${normalizedCWD})`;
  }
  return "";
}

export function truncateUTF8(message, limit) {
  const encodedMessage = Buffer.from(message, "utf8");
  if (encodedMessage.length <= limit) {
    return message;
  }

  let cut = limit - truncationSuffixBytes;
  if (cut < 0) {
    throw new RangeError("truncation limit is smaller than the truncation suffix");
  }
  while (cut > 0 && (encodedMessage[cut] & 0b1100_0000) === 0b1000_0000) {
    cut--;
  }
  return encodedMessage.subarray(0, cut).toString("utf8") + truncationSuffix;
}

export function buildEnvelope({
  threadID = "",
  cwd = "",
  lastAssistantMessage = "",
  teammateName = "",
} = {}) {
  const normalizedTeammateName = normalizeTeammateName(teammateName);
  const teammateID = normalizedTeammateName === "" ? "codex" : `codex:${normalizedTeammateName}`;
  const openTag =
    teammateMessageOpenTagPrefix + escapeXMLAttribute(teammateID) + teammateMessageIDSuffix;

  let lastMessage = trimUnicodeWhitespace(
    neutralizeClosingTeammateMessageTags(stringValue(lastAssistantMessage)),
  );
  if (lastMessage === "") {
    lastMessage = "The Codex turn finished without a final assistant message.";
  }

  const envelopeReserve =
    Buffer.byteLength(openTag, "utf8") +
    maximumSummaryEscapedBytes +
    Buffer.byteLength(teammateMessageOpenTagSuffix, "utf8") +
    Buffer.byteLength(teammateMessageCloseTag, "utf8");
  const bodyLimit = maximumMessageBytes - envelopeReserve;
  const metadata = notificationMetadata(
    neutralizeClosingTeammateMessageTags(stringValue(threadID)),
    neutralizeClosingTeammateMessageTags(stringValue(cwd)),
  );
  const metadataParagraph = metadata === "" ? "" : `\n\n${metadata}`;
  const messageLimit = Math.max(0, bodyLimit - Buffer.byteLength(metadataParagraph, "utf8"));

  let message = "";
  if (messageLimit > 0) {
    const candidate = messagePrefix + lastMessage;
    if (Buffer.byteLength(candidate, "utf8") <= messageLimit) {
      message = candidate;
    } else if (messageLimit > truncationSuffixBytes) {
      message = truncateUTF8(candidate, messageLimit);
    }
  }
  // neutralization grows text; truncation keeps a safe prefix and tag-free suffix
  // and therefore cannot recreate a closing tag
  const body = message + metadataParagraph;
  const envelope =
    openTag +
    notificationSummary(body) +
    teammateMessageOpenTagSuffix +
    body +
    teammateMessageCloseTag;
  const envelopeBytes = Buffer.byteLength(envelope, "utf8");
  if (envelopeBytes > maximumMessageBytes) {
    throw new Error(
      `notification envelope exceeds ${maximumMessageBytes}-byte limit (${envelopeBytes} bytes)`,
    );
  }
  const closingTagCount = envelope.split("</teammate-message>").length - 1;
  if (closingTagCount !== 1) {
    throw new Error(
      `notification envelope must contain exactly one closing teammate-message tag; found ${closingTagCount}`,
    );
  }
  return envelope;
}

export function envelopeFromStopPayload(payload, teammateName = "") {
  if (payload === null || typeof payload !== "object" || payload.hook_event_name !== "Stop") {
    return null;
  }

  return buildEnvelope({
    threadID: payload.session_id,
    cwd: payload.cwd,
    lastAssistantMessage: payload.last_assistant_message,
    teammateName,
  });
}

export function notifierFromEnvironment(environment = process.env) {
  const socketPath = stringValue(environment.CLAUDE_CODE_MESSAGING_SOCKET).replace(/^uds:/, "");
  const token = stringValue(environment.CLAUDE_CODE_MESSAGING_TOKEN);
  if (socketPath === "" && token === "") {
    return null;
  }
  if (socketPath === "") {
    throw new Error("CLAUDE_CODE_MESSAGING_SOCKET is not set");
  }
  if (token === "") {
    throw new Error("CLAUDE_CODE_MESSAGING_TOKEN is not set");
  }
  if (!socketPath.startsWith("/")) {
    throw new Error("Claude Code messaging socket path must be absolute");
  }

  return { socketPath, token, timeout: defaultSocketTimeout };
}

export async function sendMessage(message, notifier) {
  if (message === "") {
    throw new Error("message must not be empty");
  }
  if (Buffer.byteLength(message, "utf8") > maximumMessageBytes) {
    throw new Error(`message exceeds ${maximumMessageBytes}-byte limit`);
  }

  await new Promise((resolve, reject) => {
    let phase = "connect";
    let settled = false;
    let activeTimer;
    let socket;

    const clearActiveTimer = () => {
      clearTimeout(activeTimer);
      activeTimer = undefined;
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearActiveTimer();
      socket?.destroy();
      const operation =
        phase === "connect"
          ? "connect to Claude Code messaging socket"
          : "write Claude Code messaging frame";
      reject(new Error(`${operation}: ${error.message}`));
    };

    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearActiveTimer();
      socket.destroy();
      resolve();
    };

    const armTimer = () => {
      activeTimer = setTimeout(() => fail(new Error("timeout")), notifier.timeout);
    };

    armTimer();
    try {
      socket = createConnection({ path: notifier.socketPath });
    } catch (error) {
      fail(error);
      return;
    }
    socket.once("error", fail);
    socket.once("connect", () => {
      clearActiveTimer();
      phase = "write";
      armTimer();
      const authFrame = `${JSON.stringify({ type: "auth", token: notifier.token })}\n`;
      const userFrame = `${JSON.stringify({
        type: "user",
        message: { role: "user", content: message },
      })}\n`;
      socket.write(authFrame, "utf8");
      socket.end(userFrame, "utf8", succeed);
    });
  });
}

export function stdinTimeoutFromEnvironment(environment) {
  const value = stringValue(environment.CODEX_CLAUDE_NOTIFY_STDIN_TIMEOUT_MS);
  if (!/^[1-9]\d*$/.test(value)) {
    return defaultStdinTimeout;
  }
  const timeout = Number.parseInt(value, 10);
  return Number.isSafeInteger(timeout)
    ? Math.min(Math.max(timeout, 1), maximumStdinTimeout)
    : defaultStdinTimeout;
}

export async function readStdin(stream = process.stdin, environment = process.env) {
  const timeout = stdinTimeoutFromEnvironment(environment);
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ status: "timeout", timeout }), timeout);
  });
  const reading = (async () => {
    const chunks = [];
    let size = 0;
    let oversize = false;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (oversize) {
        continue;
      }
      if (size + buffer.length > maximumStdinBytes) {
        oversize = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(buffer);
      size += buffer.length;
    }
    if (oversize) {
      return { status: "oversize" };
    }
    return { status: "ok", input: Buffer.concat(chunks, size).toString("utf8") };
  })();

  try {
    return await Promise.race([reading, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function writeDiagnostic(stream, error) {
  stream.write(`codex-claude-notify: ${errorMessage(error)}\n`);
}

async function deliverEnvelope(envelope, notifier, stderr) {
  try {
    await sendMessage(envelope, notifier);
  } catch (error) {
    writeDiagnostic(stderr, new Error(`notify Claude Code: ${errorMessage(error)}`));
  }
}

export function envelopeFromNotifyArguments(cliArgs, environment = process.env) {
  let payload;
  try {
    payload = JSON.parse(cliArgs.at(-1));
  } catch (error) {
    throw new Error(`decode Codex notification: ${errorMessage(error)}`);
  }
  if (payload === null || typeof payload !== "object" || payload.type !== "agent-turn-complete") {
    return null;
  }

  const leadingArguments = cliArgs.slice(0, -1);
  let teammateName = "";
  let teammateNameFromFlag = false;
  for (let index = 0; index < leadingArguments.length; index++) {
    if (leadingArguments[index] !== "--from" || index + 1 >= leadingArguments.length) {
      continue;
    }
    teammateName = leadingArguments[index + 1];
    teammateNameFromFlag = true;
    index++;
  }
  if (!teammateNameFromFlag) {
    teammateName = stringValue(environment.CODEX_CLAUDE_NOTIFY_FROM);
  }

  return buildEnvelope({
    threadID: payload["thread-id"],
    cwd: payload.cwd,
    lastAssistantMessage: payload["last-assistant-message"],
    teammateName,
  });
}

export async function mainFromNotifyArguments(
  cliArgs,
  { stderr = process.stderr, environment = process.env } = {},
) {
  if (stringValue(environment.CODEX_CLAUDE_NOTIFY_DISABLE) !== "") {
    return;
  }

  let notifier;
  try {
    notifier = notifierFromEnvironment(environment);
  } catch (error) {
    writeDiagnostic(stderr, error);
    return;
  }
  if (notifier === null) {
    return;
  }

  let envelope;
  try {
    envelope = envelopeFromNotifyArguments(cliArgs, environment);
  } catch (error) {
    writeDiagnostic(stderr, error);
    return;
  }
  if (envelope === null) {
    return;
  }

  await deliverEnvelope(envelope, notifier, stderr);
}

export async function main({
  stdin = process.stdin,
  stderr = process.stderr,
  environment = process.env,
} = {}) {
  let stdinResult;
  try {
    stdinResult = await readStdin(stdin, environment);
  } catch (error) {
    writeDiagnostic(stderr, error);
    return;
  }

  if (stdinResult.status === "timeout") {
    writeDiagnostic(
      stderr,
      new Error(`stdin read timed out after ${stdinResult.timeout}ms; notification skipped`),
    );
    // exiting closes stdin, which releases a writer that will never send eof
    process.exit(0);
    return;
  }
  if (stringValue(environment.CODEX_CLAUDE_NOTIFY_DISABLE) !== "") {
    return;
  }
  if (stdinResult.status === "oversize") {
    writeDiagnostic(
      stderr,
      new Error(`stdin payload exceeds ${maximumStdinBytes} bytes; notification skipped`),
    );
    return;
  }

  let notifier;
  try {
    notifier = notifierFromEnvironment(environment);
  } catch (error) {
    writeDiagnostic(stderr, error);
    return;
  }
  if (notifier === null) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(stdinResult.input);
  } catch {
    return;
  }

  const envelope = envelopeFromStopPayload(
    payload,
    stringValue(environment.CODEX_CLAUDE_NOTIFY_FROM),
  );
  if (envelope === null) {
    return;
  }

  await deliverEnvelope(envelope, notifier, stderr);
}

let isDirect = false;
if (process.argv[1] !== undefined) {
  try {
    isDirect = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // leave isDirect false; only affects whether this file runs as a CLI entry point
  }
}
if (isDirect) {
  process.stderr.on("error", () => {});
  let fatalHandlerFired = false;
  const handleFatalError = (error) => {
    if (fatalHandlerFired) {
      process.exit(0);
      return;
    }
    fatalHandlerFired = true;
    try {
      writeDiagnostic(process.stderr, error);
    } catch {}
    process.exit(0);
  };

  process.on("uncaughtException", handleFatalError);
  process.on("unhandledRejection", (reason) => {
    handleFatalError(reason instanceof Error ? reason : new Error(String(reason)));
  });

  const cliArgs = process.argv.slice(2);
  const execution = cliArgs.length > 0 ? mainFromNotifyArguments(cliArgs) : main();
  execution
    .catch((error) => writeDiagnostic(process.stderr, error))
    .finally(() => {
      process.exitCode = 0;
    });
}
