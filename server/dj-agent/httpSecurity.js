const net = require("node:net");

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
    const mapped = address.slice("::ffff:".length);
    if (mapped.includes(".")) {
      address = mapped;
    } else {
      const words = mapped.split(":");
      if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
        const high = Number.parseInt(words[0], 16);
        const low = Number.parseInt(words[1], 16);
        address = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      }
    }
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
  // Never consume Express's proxy-derived request.ip or X-Forwarded-For.
  // The socket peer is the only trusted network identity for local fences.
  return normalizeIp(request?.socket?.remoteAddress);
}

function isLoopbackRequest(request) {
  return isLoopbackAddress(requestRemoteAddress(request));
}

function parsePort(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !/^[0-9]{1,5}$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

function parseHostAuthority(value) {
  if (typeof value !== "string") {
    return null;
  }
  const header = value.trim();
  if (!header || header !== value || /[\r\n\s@]/.test(header)) {
    return null;
  }

  let hostname = "";
  let portText = null;
  if (header.startsWith("[")) {
    const closing = header.indexOf("]");
    if (closing <= 1) {
      return null;
    }
    hostname = header.slice(1, closing);
    const suffix = header.slice(closing + 1);
    if (suffix && !suffix.startsWith(":")) {
      return null;
    }
    portText = suffix ? suffix.slice(1) : null;
    if (net.isIP(hostname) !== 6) {
      return null;
    }
  } else {
    if (header.includes("[") || header.includes("]")) {
      return null;
    }
    const colonCount = (header.match(/:/g) || []).length;
    if (colonCount > 1) {
      // HTTP Host uses brackets for IPv6 literals. Reject raw IPv6 here so
      // an ambiguous authority cannot be mistaken for a same-origin host.
      return null;
    }
    const separator = header.indexOf(":");
    if (separator >= 0) {
      hostname = header.slice(0, separator);
      portText = header.slice(separator + 1);
    } else {
      hostname = header;
    }
    if (!hostname) {
      return null;
    }
  }

  const port = parsePort(portText);
  if (portText !== null && port === null) {
    return null;
  }
  return {
    hostname: hostname.toLowerCase(),
    ipVersion: net.isIP(hostname),
    port,
  };
}

function parseHeaderHostname(value) {
  const parsed = parseHostAuthority(value);
  if (!parsed) {
    return "";
  }
  return parsed.ipVersion === 6 ? `[${parsed.hostname}]` : parsed.hostname;
}

function isLocalHostname(value) {
  const hostname = normalizeIp(value);
  return hostname === "localhost" || isLoopbackAddress(hostname);
}

function isLocalHostHeader(value) {
  const parsed = parseHostAuthority(value);
  return Boolean(parsed && isLocalHostname(parsed.hostname));
}

function parseOriginHeader(value) {
  if (value == null) {
    return { present: false, valid: true, origin: null };
  }
  if (typeof value !== "string") {
    return { present: true, valid: false, origin: null };
  }
  if (value.trim() === "") {
    return { present: false, valid: true, origin: null };
  }
  if (value.trim() !== value || /[\r\n]/.test(value)) {
    return { present: true, valid: false, origin: null };
  }
  try {
    const origin = new URL(value.trim());
    if ((origin.protocol !== "http:" && origin.protocol !== "https:")
      || origin.username
      || origin.password
      || origin.pathname !== "/"
      || origin.search
      || origin.hash) {
      return { present: true, valid: false, origin: null };
    }
    const hostname = String(origin.hostname || "")
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .toLowerCase();
    const ipVersion = net.isIP(hostname);
    if (!hostname || (ipVersion === 0 && hostname !== "localhost")) {
      return { present: true, valid: false, origin: null };
    }
    const defaultPort = origin.protocol === "https:" ? 443 : 80;
    return {
      present: true,
      valid: true,
      origin: value.trim(),
      protocol: origin.protocol,
      hostname: hostname.toLowerCase(),
      ipVersion,
      port: origin.port ? Number(origin.port) : defaultPort,
    };
  } catch {
    return { present: true, valid: false, origin: null };
  }
}

function isLocalOriginHeader(value) {
  const parsed = parseOriginHeader(value);
  return parsed.valid && (!parsed.present || isLocalHostname(parsed.hostname));
}

function isLocalSetupRequest(request) {
  return isLoopbackRequest(request)
    && isLocalHostHeader(request?.headers?.host)
    && isLocalOriginHeader(request?.headers?.origin);
}

function getActionRequestOrigin(request) {
  const parsed = parseOriginHeader(request?.headers?.origin);
  return parsed.valid && parsed.present ? parsed.origin : null;
}

// HTTP diagnostic actions are permanently loopback-only. The physical pedal
// and global hotkeys run on the DJ PC itself; FOH control uses the
// authenticated /dj-link WebSocket instead of these endpoints. Admission is
// therefore identical to the setup fence and can never be widened: the
// decision uses only the actual socket peer plus local Host/Origin checks.
// Proxy headers, request.ip, env vars, and config files never override the
// peer identity.
function isActionRequestAllowed(request) {
  return isLocalSetupRequest(request);
}

function isActionPreflightAllowed(request) {
  if (String(request?.headers?.["access-control-request-method"] || "").toUpperCase() !== "POST") {
    return false;
  }
  const requestedHeaders = String(request?.headers?.["access-control-request-headers"] || "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => header !== "content-type" && header !== "accept")) {
    return false;
  }
  return isActionRequestAllowed(request);
}

module.exports = {
  getActionRequestOrigin,
  isActionPreflightAllowed,
  isActionRequestAllowed,
  isLoopbackAddress,
  isLoopbackRequest,
  isLocalHostHeader,
  isLocalHostname,
  isLocalOriginHeader,
  isLocalSetupRequest,
  normalizeIp,
  parseHostAuthority,
  parseHeaderHostname,
  parseOriginHeader,
  requestRemoteAddress,
};
