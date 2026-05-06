const { EventEmitter } = require("node:events");

function createAbletonLinkProvider({
  enabled = true,
  moduleName = "@ktamas77/abletonlink",
  initialTempo = 120.0,
  sampleIntervalMs = 200,
} = {}) {
  const emitter = new EventEmitter();
  let link = null;
  let timer = null;
  let lastPeers = null;

  function emitStatus(ok, message, extra = {}) {
    emitter.emit("status", {
      ok,
      message,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  function start() {
    if (!enabled) {
      emitStatus(false, "Ableton Link provider disabled by config");
      return;
    }

    let moduleExport;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      moduleExport = require(moduleName);
    } catch (error) {
      emitStatus(
        false,
        `Unable to load ${moduleName}. Install it with "npm install ${moduleName}" and ensure native build tools are installed.`,
        { error: error.message }
      );
      return;
    }

    const AbletonLink = moduleExport.AbletonLink || moduleExport.default || moduleExport;
    if (typeof AbletonLink !== "function") {
      emitStatus(false, `${moduleName} does not expose an AbletonLink constructor`);
      return;
    }

    try {
      link = new AbletonLink(initialTempo);
      if (typeof link.enable === "function") {
        link.enable(true);
      }
      if (typeof link.enableStartStopSync === "function") {
        link.enableStartStopSync(true);
      }

      if (typeof link.setTempoCallback === "function") {
        link.setTempoCallback((tempo) => {
          emitter.emit("bpm", {
            value: Number(tempo),
            source: "ableton-link",
            updatedAt: new Date().toISOString(),
          });
        });
      }

      if (typeof link.setNumPeersCallback === "function") {
        link.setNumPeersCallback((numPeers) => {
          emitStatus(true, "Ableton Link connected", { peers: Number(numPeers) });
        });
      }

      timer = setInterval(() => {
        try {
          const peers = typeof link.getNumPeers === "function" ? Number(link.getNumPeers()) : 0;
          const tempo = typeof link.getTempo === "function" ? Number(link.getTempo()) : null;
          const isPlaying =
            typeof link.isPlaying === "function" ? Boolean(link.isPlaying()) : null;

          emitter.emit("bpm", {
            value: Number.isFinite(tempo) ? tempo : null,
            peers,
            isPlaying,
            source: "ableton-link",
            updatedAt: new Date().toISOString(),
          });

          if (lastPeers !== peers) {
            emitStatus(true, "Ableton Link connected", { peers });
            lastPeers = peers;
          }
        } catch (error) {
          emitStatus(false, `Ableton Link sampling error: ${error.message}`);
        }
      }, sampleIntervalMs);

      emitStatus(true, "Ableton Link provider started", { peers: 0 });
    } catch (error) {
      emitStatus(false, `Failed to initialize Ableton Link: ${error.message}`);
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (link && typeof link.enable === "function") {
      try {
        link.enable(false);
      } catch {
        // no-op
      }
    }
    link = null;
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    start,
    stop,
  };
}

module.exports = { createAbletonLinkProvider };
