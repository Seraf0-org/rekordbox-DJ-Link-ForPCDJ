const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const readline = require("node:readline");

function createPythonBridge({ pythonBin, scriptPath, args = [] }) {
  const emitter = new EventEmitter();
  let child = null;

  function emitStatus(ok, message, extra = {}) {
    emitter.emit("status", {
      ok,
      message,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  function parseStdoutLine(line) {
    if (!line || !line.trim()) {
      return;
    }

    try {
      const packet = JSON.parse(line);
      if (packet.type === "status") {
        emitStatus(Boolean(packet.ok), packet.message || "", packet.payload || {});
      } else if (packet.type === "snapshot") {
        emitter.emit("snapshot", packet.payload || {});
      } else if (packet.type === "warning") {
        emitter.emit("warning", packet.message || "Unknown warning");
      } else if (packet.type === "log") {
        emitter.emit("log", packet.message || "");
      }
    } catch {
      emitter.emit("log", `[python-bridge/raw] ${line}`);
    }
  }

  function start() {
    if (child) {
      return;
    }

    const fullArgs = [scriptPath, ...args];
    child = spawn(pythonBin, fullArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    emitStatus(true, "Python bridge starting", { pid: child.pid });

    const stdoutReader = readline.createInterface({ input: child.stdout });
    const stderrReader = readline.createInterface({ input: child.stderr });

    stdoutReader.on("line", parseStdoutLine);
    stderrReader.on("line", (line) => {
      emitter.emit("log", `[python-bridge/stderr] ${line}`);
    });

    child.on("error", (error) => {
      emitStatus(false, `Python bridge failed to start: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
      emitStatus(
        false,
        `Python bridge stopped (code=${code ?? "null"}, signal=${signal ?? "null"})`
      );
      child = null;
    });
  }

  function stop() {
    if (!child) {
      return;
    }
    child.kill("SIGTERM");
    child = null;
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    start,
    stop,
  };
}

module.exports = { createPythonBridge };
