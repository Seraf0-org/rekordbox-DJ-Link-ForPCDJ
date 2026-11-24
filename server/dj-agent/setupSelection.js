"use strict";

function strictPort(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function strictDeviceName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function exactMidiPort(ports, port, device) {
  const expectedPort = strictPort(port);
  const expectedDevice = strictDeviceName(device);
  if (expectedPort === null || expectedDevice === null || !Array.isArray(ports)) {
    return null;
  }
  const matches = ports.filter((entry) =>
    strictPort(entry?.port) === expectedPort
      && strictDeviceName(entry?.name) === expectedDevice
  );
  return matches.length === 1 ? { port: expectedPort, name: expectedDevice } : null;
}

function verifyRuntimeMidiSelection({ config, runtime, ports } = {}) {
  const configured = exactMidiPort(ports, config?.port, config?.device);
  if (!configured || runtime?.ok !== true || runtime?.available !== true) {
    return { configured: Boolean(configured), nameVerified: false, ready: false };
  }
  const runtimePort = strictPort(runtime.port);
  const runtimeDevice = strictDeviceName(runtime.device);
  const nameVerified = runtimePort === configured.port && runtimeDevice === configured.name;
  return {
    configured: true,
    nameVerified,
    ready: nameVerified,
    port: nameVerified ? configured.port : null,
    device: nameVerified ? configured.name : null,
  };
}

module.exports = {
  exactMidiPort,
  strictDeviceName,
  strictPort,
  verifyRuntimeMidiSelection,
};
