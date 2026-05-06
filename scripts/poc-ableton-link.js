const moduleName = process.env.ABLETON_LINK_MODULE || "@ktamas77/abletonlink";
const initialTempo = Number(process.env.ABLETON_LINK_INITIAL_TEMPO || 120);
const sampleCount = Number(process.env.ABLETON_LINK_SAMPLE_COUNT || 10);
const sampleIntervalMs = Number(process.env.ABLETON_LINK_SAMPLE_INTERVAL_MS || 500);

function print(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

let lib;
try {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  lib = require(moduleName);
} catch (error) {
  print({
    ok: false,
    module: moduleName,
    error: `Unable to load ${moduleName}: ${error.message}`,
    hint: `Run: npm install ${moduleName}`,
  });
  process.exit(1);
}

const AbletonLink = lib.AbletonLink || lib.default || lib;
if (typeof AbletonLink !== "function") {
  print({
    ok: false,
    module: moduleName,
    error: "Module does not expose AbletonLink constructor",
  });
  process.exit(1);
}

let link;
try {
  link = new AbletonLink(initialTempo);
  link.enable(true);
  if (typeof link.enableStartStopSync === "function") {
    link.enableStartStopSync(true);
  }
} catch (error) {
  print({ ok: false, module: moduleName, error: error.message });
  process.exit(1);
}

const samples = [];
let index = 0;

const timer = setInterval(() => {
  index += 1;
  const sample = {
    index,
    tempo: typeof link.getTempo === "function" ? Number(link.getTempo()) : null,
    peers: typeof link.getNumPeers === "function" ? Number(link.getNumPeers()) : null,
    isPlaying: typeof link.isPlaying === "function" ? Boolean(link.isPlaying()) : null,
    at: new Date().toISOString(),
  };
  samples.push(sample);
  if (index >= sampleCount) {
    clearInterval(timer);
    if (typeof link.enable === "function") {
      link.enable(false);
    }
    print({ ok: true, module: moduleName, sampleCount, sampleIntervalMs, samples });
    process.exit(0);
  }
}, sampleIntervalMs);
