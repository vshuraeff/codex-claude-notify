#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import process from "node:process";

const socketPath = process.argv[2];
const outputPath = process.argv[3];

if (socketPath === undefined || outputPath === undefined) {
  process.stderr.write("usage: listener.mjs <socket-path> <output-path>\n");
  process.exit(2);
}

fs.rmSync(socketPath, { force: true });
fs.writeFileSync(outputPath, "", "utf8");

let primarySocket;
let completionCode = null;
let serverCloseStarted = false;
let serverClosed = false;
const maxBufferedBytes = 1024 * 1024;
const maxFrameCount = 4;
const maxTotalFrameBytes = 4 * 1024 * 1024;

const server = net.createServer((socket) => {
  if (primarySocket !== undefined) {
    socket.destroy();
    return;
  }

  primarySocket = socket;
  startServerClose();

  let buffered = "";
  let frameCount = 0;
  let totalFrameBytes = 0;
  let totalRawBytes = 0;
  socket.setEncoding("utf8");

  socket.on("data", (chunk) => {
    totalRawBytes += Buffer.byteLength(chunk, "utf8");
    if (totalRawBytes > maxTotalFrameBytes) {
      fail(new Error("total raw size exceeded 4 MiB"));
      socket.destroy();
      return;
    }
    if (completionCode !== null) {
      return;
    }

    buffered += chunk;

    let newlineIndex;
    while ((newlineIndex = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);

      if (line.trim() !== "") {
        const frameBytes = Buffer.byteLength(`${line}\n`, "utf8");
        if (frameCount + 1 > maxFrameCount) {
          fail(new Error("frame count exceeded 4"));
          return;
        }
        if (totalFrameBytes + frameBytes > maxTotalFrameBytes) {
          fail(new Error("total frame size exceeded 4 MiB"));
          return;
        }
        try {
          fs.appendFileSync(outputPath, `${line}\n`, "utf8");
        } catch (error) {
          fail(error);
          return;
        }
        frameCount += 1;
        totalFrameBytes += frameBytes;
      }
    }

    if (Buffer.byteLength(buffered, "utf8") > maxBufferedBytes) {
      fail(new Error("line buffer exceeded 1 MiB"));
      socket.destroy();
      return;
    }
  });

  socket.once("end", () => {
    if (buffered.trim() !== "") {
      fail(new Error("connection ended with unterminated trailing data"));
      return;
    }
    complete(0);
  });
  socket.once("close", () => complete(0));
  socket.once("error", fail);
});

function removeSocketFile() {
  try {
    fs.rmSync(socketPath, { force: true });
    return true;
  } catch (error) {
    process.stderr.write(`listener: ${error.message}\n`);
    return false;
  }
}

function exitIfReady() {
  if (completionCode === null || !serverClosed) {
    return;
  }

  const exitCode = removeSocketFile() ? completionCode : 1;
  process.exit(exitCode);
}

function startServerClose() {
  if (serverCloseStarted) {
    return;
  }
  serverCloseStarted = true;

  if (!server.listening) {
    clearTimeout(timeout);
    serverClosed = true;
    exitIfReady();
    return;
  }

  server.close((error) => {
    clearTimeout(timeout);
    if (error !== undefined) {
      process.stderr.write(`listener: ${error.message}\n`);
      completionCode = 1;
    }
    serverClosed = true;
    exitIfReady();
  });
}

function complete(exitCode) {
  if (completionCode !== null) {
    return;
  }

  completionCode = exitCode;
  startServerClose();
  exitIfReady();
}

function fail(error) {
  if (completionCode !== null) {
    return;
  }

  process.stderr.write(`listener: ${error.message}\n`);
  completionCode = 1;
  primarySocket?.destroy();
  startServerClose();
  exitIfReady();
}

server.once("error", fail);

const timeout = setTimeout(() => {
  process.stderr.write("listener: timed out waiting for a completed connection\n");
  completionCode = 1;
  primarySocket?.destroy();
  startServerClose();
  exitIfReady();
}, 120000);

server.listen(socketPath);
