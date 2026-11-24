const { EventEmitter } = require("node:events");

const ABLETON_LINK_MODULE_NAME = "@ktamas77/abletonlink";

// The packaged release carries exactly this supported native adapter.  Do not
// turn the caller-controlled configuration value into a require() expression:
// pkg cannot bundle an arbitrary module name, and an installed process must
// never load an unreviewed native addon merely because an environment variable
// names it.  The literal require is intentional and must remain a string
// literal so pkg can follow it in both development and packaged builds.
function resolveAbletonLinkModule(moduleName = ABLETON_LINK_MODULE_NAME) {
  if (moduleName !== ABLETON_LINK_MODULE_NAME) {
    return {
      module: null,
      reason: "unsupported-module",
      error: null,
    };
  }
  try {
    return {
      module: require("@ktamas77/abletonlink"),
      reason: null,
      error: null,
    };
  } catch (error) {
    return {
      module: null,
      reason: "native-module-unavailable",
      error,
    };
  }
}

function createAbletonLinkProvider({
  enabled = true,
  moduleName = ABLETON_LINK_MODULE_NAME,
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

    const resolution = resolveAbletonLinkModule(moduleName);
    if (!resolution.module) {
      if (resolution.reason === "unsupported-module") {
        emitStatus(
          false,
          `Unsupported Ableton Link module; only ${ABLETON_LINK_MODULE_NAME} is packaged`,
          { reason: resolution.reason },
        );
        return;
      }
      emitStatus(
        false,
        `Unable to load ${ABLETON_LINK_MODULE_NAME}. Install the packaged native dependency and ensure its architecture matches Node.`,
        { reason: resolution.reason, error: resolution.error?.message },
      );
      return;
    }
    const moduleExport = resolution.module;

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

module.exports = {
  ABLETON_LINK_MODULE_NAME,
  createAbletonLinkProvider,
  resolveAbletonLinkModule,
};
