#!/usr/bin/env bun

import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

export const messagePrefix = "[Codex turn complete] ";
export const senderPrefix = "from=";
export const maximumTeammateNameRunes = 64;
export const maximumMessageBytes = 64 * 1024;
export const maximumStdinBytes = 8 * 1024 * 1024;
export const defaultSocketTimeout = 3000;
const defaultStdinTimeout = 30000;
const maximumStdinTimeout = 2_147_483_647;
const truncationSuffix = "\n\n[notification truncated]";
const truncationSuffixBytes = Buffer.byteLength(truncationSuffix, "utf8");
const crossSessionCloseTag = "\n</cross-session-message>";
// claude also recognizes closing tags with unicode brackets or invisible marks.
const openingBrackets = "<\uFF1C\uFE64\u2329\u27E8\u3008\u2039\u02C2\u1438\u276C\u276E\u2770\u29FC\u226E\u227A\u22D6";
const closingBrackets = ">\uFF1E\uFE65\u232A\u27E9\u3009\u203A\u02C3\u1433\u276D\u276F\u2771\u29FD\u226F\u227B\u22D7";
const slashes = "/\uFF0F\u2215\u2044";
const tagFiller = `^A-Za-z0-9_\\-${openingBrackets}${closingBrackets}`;
const closingPeerTag = new RegExp(
  `[${openingBrackets}](?!\\\\)(?=[${tagFiller}${slashes}]*[${slashes}][${tagFiller}]*` +
    [..."cross-session-message"].join("[\\p{C}\\p{M}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}]*") +
    ")",
  "giu",
);
const unicodeWhitespacePattern = /^\p{White_Space}$/u;
const dedupeMarkerTTLMillis = 60_000;
const maxDedupeMarkersPrunedPerCall = 64;
const dedupeMarkerDirectoryName = "codex-claude-notify-dedupe";

function dedupeMarkerDirectory(environment) {
  const runtimeDirectory = stringValue(environment.XDG_RUNTIME_DIR);
  return join(runtimeDirectory === "" ? tmpdir() : runtimeDirectory, dedupeMarkerDirectoryName);
}

function dedupeMarkerFilename(threadID) {
  const normalizedThreadID = trimUnicodeWhitespace(stringValue(threadID));
  const sanitizedThreadID = normalizedThreadID.replace(/[^A-Za-z0-9._-]/g, "");
  if (sanitizedThreadID === "" || sanitizedThreadID === "." || sanitizedThreadID === "..") {
    return "";
  }

  const encodedThreadID = Buffer.from(normalizedThreadID, "utf8").toString("hex");
  return encodedThreadID.length <= 255 ? encodedThreadID : "";
}

export function dedupeMarkerPath(threadID, environment) {
  const filename = dedupeMarkerFilename(threadID);
  return filename === "" ? "" : join(dedupeMarkerDirectory(environment), filename);
}

function dedupeMarkerTimestamp(value) {
  const separatorIndex = value.indexOf(":");
  const timestampValue = separatorIndex === -1 ? value : value.slice(separatorIndex + 1);
  if (!/^\d+$/.test(timestampValue)) {
    return null;
  }
  const timestamp = Number(timestampValue);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function dedupeMarkerSender(value) {
  const separatorIndex = value.indexOf(":");
  return separatorIndex > 0 && dedupeMarkerTimestamp(value) !== null
    ? value.slice(0, separatorIndex)
    : "";
}

function isFreshDedupeMarkerValue(value, now) {
  const timestamp = dedupeMarkerTimestamp(value);
  const elapsed = now - timestamp;
  return timestamp !== null && elapsed >= 0 && elapsed < dedupeMarkerTTLMillis;
}

function dedupeMarkerValue(sender, now) {
  const normalizedSender = stringValue(sender);
  return normalizedSender === "" ? String(now) : `${normalizedSender}:${now}`;
}

function pruneDedupeMarkers(directory, now) {
  let filenames;
  try {
    filenames = readdirSync(directory);
  } catch {
    return;
  }

  for (const filename of filenames.slice(0, maxDedupeMarkersPrunedPerCall)) {
    try {
      const timestamp = dedupeMarkerTimestamp(
        readFileSync(join(directory, filename), "utf8"),
      );
      if (
        timestamp === null ||
        now - timestamp > dedupeMarkerTTLMillis ||
        timestamp > now
      ) {
        unlinkSync(join(directory, filename));
      }
    } catch {}
  }
}

export function writeDedupeMarker(threadID, environment = process.env) {
  try {
    const markerPath = dedupeMarkerPath(threadID, environment);
    if (markerPath === "") {
      return;
    }

    const directory = dedupeMarkerDirectory(environment);
    const now = Date.now();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(markerPath, String(now), { mode: 0o600 });
    pruneDedupeMarkers(directory, now);
  } catch {}
}

export function claimDedupeMarker(threadID, environment = process.env, sender = "") {
  try {
    const markerPath = dedupeMarkerPath(threadID, environment);
    if (markerPath === "") {
      return true;
    }

    const directory = dedupeMarkerDirectory(environment);
    const markerSender = stringValue(sender);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      let fileDescriptor;
      try {
        fileDescriptor = openSync(markerPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          return true;
        }
        let markerValue;
        try {
          markerValue = readFileSync(markerPath, "utf8");
        } catch {
          return true;
        }
        if (
          isFreshDedupeMarkerValue(markerValue, Date.now()) &&
          (markerSender === "" || dedupeMarkerSender(markerValue) !== markerSender)
        ) {
          return false;
        }
        try {
          unlinkSync(markerPath);
        } catch {}
        continue;
      }

      const now = Date.now();
      try {
        writeFileSync(fileDescriptor, dedupeMarkerValue(markerSender, now));
      } finally {
        closeSync(fileDescriptor);
      }
      pruneDedupeMarkers(directory, now);
      return true;
    }
  } catch {}
  return true;
}

export function hasFreshDedupeMarker(threadID, environment = process.env) {
  try {
    const markerPath = dedupeMarkerPath(threadID, environment);
    if (markerPath === "") {
      return false;
    }

    return isFreshDedupeMarkerValue(readFileSync(markerPath, "utf8"), Date.now());
  } catch {
    return false;
  }
}

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

function neutralizeEnvelopeTags(value) {
  // include tag-name prefixes so truncation cannot create a new closing tag.
  return value.replace(closingPeerTag, "<\\").replace(
    /<\/?(?:cross-session-message|teammate-message|agent-message)/gi,
    (tag) => `<\\${tag.slice(1)}`,
  );
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
  const sender = normalizedTeammateName === "" ? "codex" : `codex:${normalizedTeammateName}`;
  // claude's peer parser round-trips this name without decoding xml entities.
  const displayName = clampCodePoints(
    sender.replace(/["<>\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, "").trim(),
    maximumTeammateNameRunes,
  ).trimEnd();
  const openTag = `<cross-session-message from="codex" from-name="${displayName}">\n`;
  const header = neutralizeEnvelopeTags(`${messagePrefix}${senderPrefix}${sender}\n`);

  let lastMessage = neutralizeEnvelopeTags(trimUnicodeWhitespace(stringValue(lastAssistantMessage)));
  if (lastMessage === "") {
    lastMessage = "The Codex turn finished without a final assistant message.";
  }

  const bodyLimit = maximumMessageBytes - Buffer.byteLength(openTag + header + crossSessionCloseTag, "utf8");
  const metadata = neutralizeEnvelopeTags(notificationMetadata(threadID, cwd));
  const metadataParagraph = metadata === "" ? "" : `\n\n${metadata}`;
  const messageLimit = Math.max(0, bodyLimit - Buffer.byteLength(metadataParagraph, "utf8"));

  let message = "";
  if (messageLimit > 0) {
    if (Buffer.byteLength(lastMessage, "utf8") <= messageLimit) {
      message = lastMessage;
    } else if (messageLimit > truncationSuffixBytes) {
      message = truncateUTF8(lastMessage, messageLimit);
    }
  }

  const notification = openTag + header + message + metadataParagraph + crossSessionCloseTag;
  const notificationBytes = Buffer.byteLength(notification, "utf8");
  if (notificationBytes > maximumMessageBytes) {
    throw new Error(
      `notification exceeds ${maximumMessageBytes}-byte limit (${notificationBytes} bytes)`,
    );
  }
  return notification;
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

// the first rollout record is session_meta; a real peer header measured 22,711 bytes.
export const maximumTranscriptHeaderBytes = 1024 * 1024;

export function readTranscriptHeader(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") {
    return null;
  }
  let fd;
  try {
    // nonblocking open keeps a fifo planted at the path from hanging the hook
    fd = openSync(transcriptPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      return null;
    }
    const buffer = Buffer.alloc(maximumTranscriptHeaderBytes);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) {
        break;
      }
      const newline = buffer.subarray(length, length + read).indexOf(0x0a);
      if (newline !== -1) {
        return buffer.toString("utf8", 0, length + newline);
      }
      length += read;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// CODEX_CLAUDE_NOTIFY_SOURCES, a comma list of rollout sources ("cli" for the
// interactive tui, "exec" for codex exec), restricts Stop delivery to sessions
// whose rollout header records one of them. unset or empty delivers for every
// session. a launcher sets it so that processes its session starts, which
// inherit the environment, stay silent.
export function allowedSourcesFromEnvironment(environment = process.env) {
  const sources = stringValue(environment.CODEX_CLAUDE_NOTIFY_SOURCES)
    .split(",")
    .map((source) => source.trim())
    .filter((source) => source !== "");
  return sources.length === 0 ? null : sources;
}

export function isAllowedStopPayload(payload, allowedSources) {
  if (payload === null || typeof payload !== "object" || payload.hook_event_name !== "Stop") {
    return false;
  }
  if (allowedSources === null) {
    return true;
  }
  const sessionID = stringValue(payload.session_id).toLowerCase();
  if (sessionID === "") {
    return false;
  }
  const header = readTranscriptHeader(payload.transcript_path);
  if (header === null) {
    return false;
  }
  let record;
  try {
    record = JSON.parse(header);
  } catch {
    return false;
  }
  const meta = record?.payload;
  return (
    record?.type === "session_meta" &&
    meta !== null &&
    typeof meta === "object" &&
    typeof meta.source === "string" &&
    allowedSources.includes(meta.source) &&
    stringValue(meta.id).toLowerCase() === sessionID
  );
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

export async function sendMessage(message, notifier, { connect = createConnection } = {}) {
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
      socket = connect({ path: notifier.socketPath });
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
    return true;
  } catch (error) {
    writeDiagnostic(stderr, new Error(`notify Claude Code: ${errorMessage(error)}`));
    return false;
  }
}

function removeDedupeMarker(threadID, environment) {
  try {
    const markerPath = dedupeMarkerPath(threadID, environment);
    if (markerPath !== "") {
      unlinkSync(markerPath);
    }
  } catch {}
}

function threadIDFromNotifyArguments(cliArgs) {
  try {
    const payload = JSON.parse(cliArgs.at(-1));
    return payload !== null && typeof payload === "object" && payload.type === "agent-turn-complete"
      ? payload["thread-id"]
      : "";
  } catch {
    return "";
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

  const threadID = threadIDFromNotifyArguments(cliArgs);
  if (!claimDedupeMarker(threadID, environment, "from")) {
    removeDedupeMarker(threadID, environment);
    return;
  }
  if (!(await deliverEnvelope(envelope, notifier, stderr))) {
    removeDedupeMarker(threadID, environment);
  }
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
  if (envelope === null || !isAllowedStopPayload(payload, allowedSourcesFromEnvironment(environment))) {
    return;
  }

  if (!claimDedupeMarker(payload.session_id, environment, "stop")) {
    removeDedupeMarker(payload.session_id, environment);
    return;
  }

  if (!(await deliverEnvelope(envelope, notifier, stderr))) {
    removeDedupeMarker(payload.session_id, environment);
  }
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
