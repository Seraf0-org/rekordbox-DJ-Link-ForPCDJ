function normalizeIp(value) {
  let address = String(value || "").trim().toLowerCase();
  if (!address) {
    return "";
  }
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) {
    address = address.slice(0, zoneIndex);
  }
  if (address.startsWith("::ffff:")) {
    address = address.slice("::ffff:".length);
  }
  return address;
}

function isLoopbackAddress(value) {
  const address = normalizeIp(value);
  if (address === "::1") {
    return true;
  }
  const octets = address.split(".").map((part) => Number(part));
  return (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    octets[0] === 127
  );
}

function requestRemoteAddress(request) {
  return normalizeIp(request?.socket?.remoteAddress || request?.connection?.remoteAddress || request?.ip);
}

function isLoopbackRequest(request) {
  return isLoopbackAddress(requestRemoteAddress(request));
}

module.exports = {
  isLoopbackAddress,
  isLoopbackRequest,
  normalizeIp,
  requestRemoteAddress,
};
