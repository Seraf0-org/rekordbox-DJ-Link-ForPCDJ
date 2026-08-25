"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "..", "server", "public");
const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
const css = fs.readFileSync(path.join(PUBLIC_DIR, "styles.css"), "utf8");

const FIELD_ORDER_KEY = "rb-output-field-order";
const FIELDS = ["title", "artist", "album", "genre", "key", "label", "realtimebpm", "trackbpm", "time"];

test("served page loads only origin-local scripts and no remote CDN script remains", () => {
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  assert.deepEqual(srcs, ["/socket.io/socket.io.js", "/app.js"]);
  for (const src of srcs) {
    assert.equal(src.startsWith("/"), true, `script src must be origin-local: ${src}`);
    assert.doesNotMatch(src, /^(?:https?:)?\/\//i);
  }
});

test("no sortablejs dependency or dynamic code execution remains in client assets", () => {
  assert.doesNotMatch(html, /sortablejs/i);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com/i);
  assert.doesNotMatch(app, /\bSortable\b/);
  assert.doesNotMatch(app, /createElement\(\s*["']script["']/i);
  assert.doesNotMatch(app, /\beval\s*\(|new\s+Function\s*\(/);
});

test("field ordering block is native-only, performs no network access, and builds no selectors by interpolation", () => {
  const start = app.indexOf("const FIELD_ORDER_KEY");
  const end = app.indexOf("\ninitSortableFields();", start);
  assert.ok(start >= 0 && end > start);
  const block = app.slice(start, end);
  assert.match(block, /setAttribute\(\s*"draggable"\s*,\s*"true"\s*\)/);
  assert.match(block, /insertBefore\(/);
  for (const type of ["dragstart", "dragover", "drop", "dragend", "click", "keydown"]) {
    assert.match(block, new RegExp(`addEventListener\\("${type}"`));
  }
  assert.match(block, /ArrowUp/);
  assert.match(block, /ArrowDown/);
  assert.doesNotMatch(block, /fetch\(|XMLHttpRequest|WebSocket|importScripts|sendBeacon/);
  assert.doesNotMatch(block, /\bquerySelector(?:All)?\s*\(\s*`/, "dataset lookups must not build selectors from interpolated values");
  assert.doesNotMatch(block, /`[^`]*data-field[^`]*`/, "dataset fields must be found by attribute comparison, not selector construction");
});

test("every sortable field exposes keyboard-accessible up and down controls outside its checkbox label", () => {
  const listStart = html.indexOf('id="fieldSortableList"');
  const listEnd = html.indexOf("</details>", listStart);
  assert.ok(listStart >= 0 && listEnd > listStart);
  const listHtml = html.slice(listStart, listEnd);

  const items = [...listHtml.matchAll(/<div class="sortable-item" data-field="([a-z]+)">[\s\S]*?<\/div>/g)];
  assert.deepEqual(items.map((m) => m[1]), FIELDS);
  assert.doesNotMatch(listHtml, /\sstyle="/, "sortable rows must be styled by project CSS only");
  assert.doesNotMatch(listHtml, /https?:\/\//i);

  const seenLabels = new Set();
  for (const [, field] of items) {
    const itemStart = listHtml.indexOf(`<div class="sortable-item" data-field="${field}">`);
    const itemEnd = listHtml.indexOf("</div>", itemStart);
    const item = listHtml.slice(itemStart, itemEnd);
    assert.match(item, /<span class="drag-glyph" aria-hidden="true">/);
    const checkboxLabel = item.match(/<label class="sortable-label">([\s\S]*?)<\/label>/);
    assert.ok(checkboxLabel, `${field} must keep a dedicated checkbox label`);
    assert.match(checkboxLabel[1], /<input type="checkbox"/);
    assert.doesNotMatch(checkboxLabel[1], /<button\b/, `${field} buttons must sit outside the checkbox label`);
    for (const dir of ["up", "down"]) {
      const buttonRe = `<button type="button" class="sortable-move" data-move="${dir}"`;
      assert.equal(item.split(buttonRe).length - 1, 1, `${field} needs exactly one ${dir} control`);
      const labelMatch = item.match(new RegExp(`aria-label="Move ([^"]+) ${dir}"`));
      assert.ok(labelMatch, `${field} missing ${dir} aria-label`);
      assert.ok(!seenLabels.has(labelMatch[1] + dir), `duplicate aria-label for ${field} ${dir}`);
      seenLabels.add(labelMatch[1] + dir);
      const expectedName = field === "realtimebpm" ? "Realtime BPM" : field === "trackbpm" ? "Track BPM" : field;
      assert.match(labelMatch[1].toLowerCase(), new RegExp(expectedName.toLowerCase().replace(" ", "\\s*")));
    }
  }
});

test("reorder results ship as a polite atomic live region placed after the sortable list", () => {
  const liveMatch = html.match(/<p id="fieldSortableStatus"[^>]*>/);
  assert.ok(liveMatch, "fieldSortableStatus live region must exist in served HTML");
  assert.match(liveMatch[0], /class="sortable-status"/);
  assert.match(liveMatch[0], /role="status"/);
  assert.match(liveMatch[0], /aria-live="polite"/);
  assert.match(liveMatch[0], /aria-atomic="true"/);
  const listIdx = html.indexOf('id="fieldSortableList"');
  const detailsEnd = html.indexOf("</details>", listIdx);
  const statusIdx = html.indexOf('id="fieldSortableStatus"');
  assert.ok(listIdx >= 0 && detailsEnd > listIdx);
  assert.ok(statusIdx > listIdx && statusIdx < detailsEnd, "live region must sit with the sortable list");
  const orderingBlock = app.slice(app.indexOf("const FIELD_ORDER_KEY"), app.indexOf("\ninitSortableFields();"));
  assert.doesNotMatch(orderingBlock, /\.focus\(/, "announcements must never move focus");
});

test("shipped stylesheet consumes only defined custom properties and uses the card border variable", () => {
  const definedVars = new Set([...css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const usedVars = [...new Set([...css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((m) => m[1]))];
  assert.ok(usedVars.length > 0);
  for (const name of usedVars) {
    assert.ok(definedVars.has(name), `${name} is consumed but never defined`);
  }
  assert.doesNotMatch(css, /var\(\s*--border\s*\)/, "undefined --border must stay fixed to --card-border");
});

function collectCssRules(cssText) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    rules.push({ selector: m[1].trim().split("\n").pop().trim(), body: m[2] });
  }
  return rules;
}

test("sortable label hit target is at least 36px tall without shrinking typography or controls", () => {
  const rules = collectCssRules(css);

  const labelRule = rules.find((r) => r.selector === ".sortable-label");
  assert.ok(labelRule, "base .sortable-label rule must exist");
  assert.match(labelRule.body, /min-height:\s*36px/, "label hit target must be at least 36px tall");
  assert.doesNotMatch(labelRule.body, /font-size\s*:/, "label hit-target fix must not touch typography");
  assert.match(labelRule.body, /align-items:\s*center/, "checkbox and text must stay centered in the taller target");

  const moveRule = rules.find((r) => r.selector === ".sortable-move");
  assert.ok(moveRule, "base .sortable-move rule must exist");
  assert.match(moveRule.body, /min-width:\s*36px/, "touch fallback buttons must stay 36px wide");
  assert.match(moveRule.body, /min-height:\s*36px/, "touch fallback buttons must stay 36px tall");

  for (const rule of rules.filter((r) => /input\[type="checkbox"\]/.test(r.selector))) {
    assert.doesNotMatch(rule.body, /(^|[^-])\b(width|height)\s*:/, "checkbox rendering must not be resized by CSS");
  }

  const itemRule = rules.find((r) => r.selector === ".sortable-item");
  assert.ok(itemRule, "base .sortable-item rule must exist");
  assert.match(itemRule.body, /min-height:\s*36px/);
});

// ---------------------------------------------------------------------------
// Minimal DOM/localStorage shim so the real app.js ordering code runs
// deterministically against markup parsed out of the REAL index.html, without
// a browser or any remotely fetched script.
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function selectorTokens(simpleSelector) {
  const tokens = [];
  let rest = String(simpleSelector).trim();
  const tagMatch = rest.match(/^[a-zA-Z][\w-]*/);
  if (tagMatch) {
    tokens.push({ tag: tagMatch[0].toLowerCase() });
    rest = rest.slice(tagMatch[0].length);
  }
  const re = /\.([A-Za-z0-9_-]+)|\[([^\]]+)\]/g;
  const idMatch = rest.match(/^#([A-Za-z0-9_-]+)/);
  if (idMatch) {
    tokens.push({ id: idMatch[1] });
    rest = rest.slice(idMatch[0].length);
  }
  let m;
  while ((m = re.exec(rest)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ cls: m[1] });
    } else {
      const raw = m[2];
      const eq = raw.indexOf("=");
      tokens.push(eq >= 0 ? { attr: raw.slice(0, eq).trim(), val: raw.slice(eq + 1).replace(/"/g, "") } : { attr: raw.trim() });
    }
  }
  return tokens;
}

function matchesTokens(el, tokens) {
  return tokens.every((t) => {
    if (t.tag !== undefined) {
      if (el.tagName !== t.tag) return false;
    } else if (t.id !== undefined) {
      if (el.getAttribute("id") !== t.id) return false;
    } else if (t.cls) {
      if (!el.classList.contains(t.cls)) return false;
    } else if (t.attr) {
      const actual = el.getAttribute(t.attr);
      if (t.val === undefined ? actual === null : actual !== t.val) return false;
    }
    return true;
  });
}

function matchesChain(el, parts) {
  if (typeof el !== "object" || !matchesTokens(el, selectorTokens(parts[parts.length - 1]))) {
    return false;
  }
  let partIndex = parts.length - 2;
  let ancestor = el.parentNode;
  while (ancestor && partIndex >= 0) {
    if (typeof ancestor !== "string" && matchesTokens(ancestor, selectorTokens(parts[partIndex]))) {
      partIndex -= 1;
    }
    ancestor = ancestor.parentNode;
  }
  return partIndex < 0;
}

function matchesSelector(el, selector) {
  return String(selector)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((chain) => matchesChain(el, chain.split(/\s+/)));
}

function detach(node) {
  if (!node.parentNode) return;
  const siblings = node.parentNode.childNodes;
  const idx = siblings.indexOf(node);
  if (idx >= 0) siblings.splice(idx, 1);
  node.parentNode = null;
}

function createEl(tagName, attrs = {}) {
  const el = {
    tagName,
    attributes: { ...attrs },
    childNodes: [],
    parentNode: null,
    style: {},
    listeners: {},
    rect: { top: 0, height: 0 },
  };
  const classes = new Set(String(attrs.class || "").split(/\s+/).filter(Boolean));
  el.classList = {
    add: (...names) => names.forEach((n) => classes.add(n)),
    remove: (...names) => names.forEach((n) => classes.delete(n)),
    contains: (name) => classes.has(name),
  };
  el.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null);
  el.setAttribute = (name, value) => {
    el.attributes[name] = String(value);
  };
  el.removeAttribute = (name) => {
    delete el.attributes[name];
  };
  Object.defineProperty(el, "disabled", {
    get() {
      return Object.prototype.hasOwnProperty.call(el.attributes, "disabled");
    },
    set(value) {
      if (value === true) el.setAttribute("disabled", "");
      else el.removeAttribute("disabled");
    },
  });
  Object.defineProperty(el, "textContent", {
    get() {
      return el.childNodes.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
    },
    set(value) {
      el.childNodes.length = 0;
      if (value != null && value !== "") el.childNodes.push(String(value));
    },
  });
  el.matches = (selector) => matchesSelector(el, selector);
  Object.defineProperty(el, "nextSibling", {
    get() {
      if (!el.parentNode) return null;
      const siblings = el.parentNode.childNodes;
      return siblings[siblings.indexOf(el) + 1] || null;
    },
  });
  el.appendChild = (child) => {
    detach(child);
    child.parentNode = el;
    el.childNodes.push(child);
    return child;
  };
  el.insertBefore = (child, ref) => {
    if (!ref) return el.appendChild(child);
    detach(child);
    const idx = el.childNodes.indexOf(ref);
    if (idx < 0) throw new Error("insertBefore reference is not a child");
    child.parentNode = el;
    el.childNodes.splice(idx, 0, child);
    return child;
  };
  el.querySelectorAll = (selector) => {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (typeof child === "string") continue;
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(el);
    return out;
  };
  el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
  el.closest = (selector) => {
    let node = el;
    while (node) {
      if (typeof node !== "string" && matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  };
  el.addEventListener = (type, fn) => {
    (el.listeners[type] ||= []).push(fn);
  };
  el.getBoundingClientRect = () => ({ top: el.rect.top, height: el.rect.height });
  el.dispatch = (type, payload = {}) => {
    const evt = {
      target: payload.target || el,
      key: payload.key,
      clientY: payload.clientY,
      dataTransfer: payload.dataTransfer || null,
      defaultPrevented: false,
      preventDefault() {
        evt.defaultPrevented = true;
      },
    };
    for (const fn of el.listeners[type] || []) fn(evt);
    return evt;
  };
  return el;
}

function parseHtmlSubset(markup) {
  const root = createEl("#document-fragment", {});
  const stack = [root];
  const tagRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let lastIndex = 0;
  let m;
  while ((m = tagRe.exec(markup)) !== null) {
    const between = markup.slice(lastIndex, m.index);
    if (between && decodeEntities(between.replace(/\s+/g, " ")).trim()) {
      stack[stack.length - 1].childNodes.push(decodeEntities(between.replace(/\s+/g, " ")).trim());
    }
    lastIndex = tagRe.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    const [, closeSlash, tagNameRaw, attrSource, selfClose] = m;
    const tagName = tagNameRaw.toLowerCase();
    if (closeSlash) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName === tagName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = {};
    const attrRe = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = attrRe.exec(attrSource)) !== null) {
      const name = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4];
      attrs[name] = value === undefined ? "" : decodeEntities(value);
    }
    const el = createEl(tagName, attrs);
    stack[stack.length - 1].appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tagName)) stack.push(el);
  }
  return root;
}

function extractBlock(source, openTagRe, tagName) {
  const open = openTagRe.exec(source);
  if (!open) throw new Error(`fixture: opening <${tagName}> not found`);
  const re = new RegExp(`<(/?)${tagName}(?=[\\s/>])[^>]*>`, "gi");
  re.lastIndex = open.index;
  let depth = 0;
  let t;
  while ((t = re.exec(source)) !== null) {
    depth += t[1] === "/" ? -1 : 1;
    if (depth === 0) return source.slice(open.index, t.index + t[0].length);
  }
  throw new Error(`fixture: closing </${tagName}> not found`);
}

function firstElementOf(fragment) {
  const el = fragment.childNodes.find((c) => typeof c !== "string");
  if (!el) throw new Error("fixture: parsed block produced no root element");
  return el;
}

function buildPublicFixture() {
  return {
    list: firstElementOf(parseHtmlSubset(extractBlock(html, /<div\b[^>]*id="fieldSortableList"[^>]*>/i, "div"))),
    deck1: firstElementOf(parseHtmlSubset(extractBlock(html, /<article\b[^>]*id="deck1Card"[^>]*>/i, "article"))),
    deck2: firstElementOf(parseHtmlSubset(extractBlock(html, /<article\b[^>]*id="deck2Card"[^>]*>/i, "article"))),
  };
}

function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const calls = [];
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      calls.push({ op: "setItem", key: k, value: String(v) });
      map.set(k, String(v));
    },
    removeItem: (k) => {
      calls.push({ op: "removeItem", key: k });
      map.delete(k);
    },
    resetLog: () => {
      calls.length = 0;
    },
    writesTo: (key) => calls.filter((c) => c.key === key),
    calls,
  };
}

function loadOrderingModule(savedRaw) {
  const start = app.indexOf("const FIELD_ORDER_KEY");
  const end = app.indexOf("\ninitSortableFields();", start);
  assert.ok(start >= 0 && end > start);
  const source = app.slice(start, end);

  const fixture = buildPublicFixture();
  const list = fixture.list;

  const statusEl = createEl("p", {
    id: "fieldSortableStatus",
    class: "sortable-status",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });

  const controls = new Map();
  for (const item of list.querySelectorAll(".sortable-item")) {
    controls.set(item.getAttribute("data-field"), {
      up: item.querySelector('.sortable-move[data-move="up"]'),
      down: item.querySelector('.sortable-move[data-move="down"]'),
    });
  }
  assert.deepEqual([...controls.keys()].sort(), [...FIELDS].sort());

  const elements = {
    fieldSortableList: list,
    fieldSortableStatus: statusEl,
    deck1Card: fixture.deck1,
    deck2Card: fixture.deck2,
  };
  const sandbox = {
    document: { getElementById: (id) => elements[id] || null },
    localStorage: createStorage(savedRaw === undefined ? {} : { [FIELD_ORDER_KEY]: savedRaw }),
  };

  const api = vm.runInNewContext(
    `${source}\n;({ DEFAULT_FIELD_ORDER, applyFieldOrder, getFieldOrderFromList, findFieldElement, moveSortableItem, persistAndApplySortableOrder, initSortableFields, resetSortableFields });`,
    sandbox,
  );

  return {
    api,
    list,
    controls,
    elements,
    storage: sandbox.localStorage,
    listOrder: () => list.querySelectorAll("[data-field]").map((el) => el.getAttribute("data-field")),
    deckOrderByStyle: (id) =>
      Object.fromEntries(
        elements[id]
          .querySelector(".deck-fields")
          .childNodes.filter((c) => typeof c !== "string")
          .map((el) => [el.getAttribute("data-field"), el.style.order]),
      ),
  };
}

test("sortable fixture mirrors shipped div > glyph + label + controls nesting and deck row structure", () => {
  const w = loadOrderingModule(undefined);
  const items = w.list.querySelectorAll(".sortable-item");
  assert.equal(items.length, FIELDS.length);

  for (const item of items) {
    const field = item.getAttribute("data-field");
    assert.equal(item.tagName, "div", `${field} row must be a div.sortable-item`);
    const children = item.childNodes.filter((c) => typeof c !== "string");
    assert.deepEqual(
      children.map((c) => c.tagName),
      ["span", "label", "span"],
      `${field} row must nest glyph span, checkbox label, then controls span`,
    );
    assert.ok(children[0].classList.contains("drag-glyph"), `${field} glyph must carry the drag-glyph class`);
    assert.equal(children[0].getAttribute("aria-hidden"), "true");
    assert.ok(children[1].classList.contains("sortable-label"), `${field} second child must be the checkbox label`);
    assert.equal(children[1].querySelectorAll("button").length, 0, `${field} label must not contain buttons`);
    const labelParts = children[1].childNodes.filter((c) => typeof c !== "string");
    assert.equal(labelParts[0].tagName, "input");
    assert.equal(labelParts[0].getAttribute("type"), "checkbox");
    assert.equal(labelParts[1].tagName, "span");
    assert.ok(labelParts[1].classList.contains("label"));
    assert.ok(children[1].textContent.trim().length > 0, `${field} label text must survive parsing`);
    assert.ok(children[2].classList.contains("sortable-controls"), `${field} third child must be the controls span`);
    const buttons = children[2].querySelectorAll("button");
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].getAttribute("data-move"), "up");
    assert.equal(buttons[1].getAttribute("data-move"), "down");
  }

  for (const [id, deckNo] of [["deck1Card", 1], ["deck2Card", 2]]) {
    const card = w.elements[id];
    assert.equal(card.tagName, "article");
    const rows = card.querySelector(".deck-fields").childNodes.filter((c) => typeof c !== "string");
    assert.deepEqual(rows.map((r) => r.getAttribute("data-field")), FIELDS, `${id} deck rows must mirror shipped order`);
    assert.ok(rows.every((r) => r.tagName === "div"));
    assert.equal(card.querySelector(`#deck${deckNo}Title`).getAttribute("data-field"), "title");
    const timeRow = rows.find((r) => r.getAttribute("data-field") === "time");
    assert.equal(timeRow.querySelectorAll("canvas").length, 1, "time row must keep its waveform canvas");
  }
});

test("shipped HTML disables first Up and last Down with synced aria state before any script runs", () => {
  const w = loadOrderingModule(undefined);
  assert.deepEqual(w.listOrder(), FIELDS);

  const first = w.controls.get("title");
  const last = w.controls.get("time");
  assert.notEqual(first.up.getAttribute("disabled"), null, "first Up must ship disabled");
  assert.equal(first.up.getAttribute("aria-disabled"), "true");
  assert.equal(first.up.disabled, true);
  assert.equal(last.down.getAttribute("disabled") !== null, true, "last Down must ship disabled");
  assert.equal(last.down.getAttribute("aria-disabled"), "true");
  assert.equal(last.down.disabled, true);
  assert.equal(first.down.getAttribute("disabled"), null);
  assert.equal(last.up.getAttribute("disabled"), null);
  assert.equal(w.controls.get("album").up.getAttribute("disabled"), null);

  w.api.initSortableFields();
  assert.equal(first.up.disabled, true, "JS stays the source of truth after init");
  assert.equal(first.up.getAttribute("aria-disabled"), "true");
  assert.equal(first.down.disabled, false);
  assert.equal(first.down.getAttribute("aria-disabled"), "false");
  assert.equal(last.down.disabled, true);
  assert.equal(last.down.getAttribute("aria-disabled"), "true");
  assert.equal(last.up.disabled, false);
  assert.equal(last.up.getAttribute("aria-disabled"), "false");
});

test("init applies default order and enables native dragging without external libraries", () => {
  const w = loadOrderingModule(undefined);
  assert.deepEqual([...w.api.DEFAULT_FIELD_ORDER], FIELDS);
  w.api.initSortableFields();
  assert.deepEqual(w.listOrder(), FIELDS);
  for (const item of w.list.querySelectorAll("[data-field]")) {
    assert.equal(item.getAttribute("draggable"), "true");
  }
  const expected = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
  assert.deepEqual(w.deckOrderByStyle("deck1Card"), expected);
  assert.deepEqual(w.deckOrderByStyle("deck2Card"), expected);
  assert.equal(w.storage.getItem(FIELD_ORDER_KEY), null);
});

test("saved custom order is restored from localStorage and applied to both decks", () => {
  const custom = ["artist", "title", "time", "trackbpm", "realtimebpm", "label", "key", "genre", "album"];
  const w = loadOrderingModule(JSON.stringify(custom));
  w.api.initSortableFields();
  assert.deepEqual(w.listOrder(), custom);
  for (const id of ["deck1Card", "deck2Card"]) {
    const orders = w.deckOrderByStyle(id);
    for (let i = 0; i < custom.length; i += 1) {
      assert.equal(orders[custom[i]], i);
    }
  }
});

test("corrupt or non-string saved order fails closed to the default order", () => {
  for (const bad of ["{not json]", JSON.stringify(["title", 42]), JSON.stringify([])]) {
    const w = loadOrderingModule(bad);
    w.api.initSortableFields();
    assert.deepEqual(w.listOrder(), FIELDS);
  }
});

test("findFieldElement resolves dataset fields without selector construction", () => {
  const w = loadOrderingModule(undefined);
  for (const f of FIELDS) {
    const el = w.api.findFieldElement(w.list, f);
    assert.ok(el, `${f} must resolve from the list scope`);
    assert.equal(el.getAttribute("data-field"), f);
    assert.equal(w.api.findFieldElement(null, f), null);
  }
  assert.equal(w.api.findFieldElement(w.list, "nonexistent"), null);
});

test("moveSortableItem moves items one position and refuses invalid moves without mutation", () => {
  const w = loadOrderingModule(undefined);
  const first = w.list.querySelector('[data-field="title"]');
  const last = w.list.querySelector('[data-field="time"]');

  assert.equal(w.api.moveSortableItem(w.list, first, -1), false);
  assert.equal(w.api.moveSortableItem(w.list, last, 1), false);
  assert.equal(w.api.moveSortableItem(w.list, first, 0), false);
  assert.equal(w.api.moveSortableItem(w.list, first, 5), false);
  assert.equal(w.api.moveSortableItem(null, first, 1), false);
  assert.equal(w.api.moveSortableItem(w.list, null, 1), false);
  assert.deepEqual(w.listOrder(), FIELDS);

  assert.equal(w.api.moveSortableItem(w.list, first, 1), true);
  assert.deepEqual(w.listOrder().slice(0, 2), ["artist", "title"]);
  const titleAgain = w.api.findFieldElement(w.list, "title");
  assert.equal(w.api.moveSortableItem(w.list, titleAgain, -1), true);
  assert.deepEqual(w.listOrder(), FIELDS);

  const genre = w.api.findFieldElement(w.list, "genre");
  assert.equal(w.api.moveSortableItem(w.list, genre, -1), true);
  assert.deepEqual(w.listOrder().slice(0, 4), ["title", "artist", "genre", "album"]);
});

test("clicking a move control reorders the list and updates both decks", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();

  w.list.dispatch("click", { target: w.controls.get("title").down });
  const expected = ["artist", "title", ...FIELDS.slice(2)];
  assert.deepEqual(w.listOrder(), expected);
  assert.deepEqual(JSON.parse(w.storage.getItem(FIELD_ORDER_KEY)), expected);
  for (const id of ["deck1Card", "deck2Card"]) {
    const orders = w.deckOrderByStyle(id);
    assert.equal(orders.artist, 0);
    assert.equal(orders.title, 1);
    assert.equal(orders.album, 2);
  }

  w.list.dispatch("click", { target: w.controls.get("title").up });
  assert.deepEqual(w.listOrder(), FIELDS);

  const noopClick = w.list.dispatch("click", { target: w.api.findFieldElement(w.list, "title") });
  assert.deepEqual(w.listOrder(), FIELDS);
  assert.equal(noopClick.defaultPrevented, false);
});

test("accepted clicks and arrow keys persist FIELD_ORDER_KEY exactly once; blocked moves persist nothing", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();

  w.storage.resetLog();
  w.list.dispatch("click", { target: w.controls.get("title").down });
  let writes = w.storage.writesTo(FIELD_ORDER_KEY);
  assert.equal(writes.length, 1, "one accepted click must issue exactly one setItem");
  assert.equal(writes[0].op, "setItem");
  assert.deepEqual(JSON.parse(writes[0].value), w.listOrder());
  assert.equal(w.storage.calls.some((c) => c.op === "removeItem"), false, "moves must never removeItem");

  w.storage.resetLog();
  w.list.dispatch("keydown", { target: w.controls.get("title").up, key: "ArrowUp" });
  writes = w.storage.writesTo(FIELD_ORDER_KEY);
  assert.equal(writes.length, 1, "one accepted arrow key must issue exactly one setItem");
  assert.equal(w.storage.calls.length, 1, "arrow reorder must not touch any other storage key");

  w.storage.resetLog();
  const orderBefore = w.listOrder();
  const firstUp = w.controls.get(orderBefore[0]).up;
  const lastDown = w.controls.get(orderBefore.at(-1)).down;
  w.list.dispatch("click", { target: firstUp });
  w.list.dispatch("keydown", { target: firstUp, key: "ArrowUp" });
  w.list.dispatch("keydown", { target: lastDown, key: "ArrowDown" });
  w.list.dispatch("click", { target: w.api.findFieldElement(w.list, "title") });
  assert.deepEqual(w.listOrder(), orderBefore, "blocked and noop interactions must not mutate");
  assert.equal(w.storage.calls.length, 0, "blocked movement must persist zero storage operations");
});

test("native drag persists exactly once on dragend and syncs control state afterwards", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();

  const items = new Map(w.list.querySelectorAll(".sortable-item").map((el) => [el.getAttribute("data-field"), el]));
  let index = 0;
  for (const f of FIELDS) items.get(f).rect = { top: index++ * 40, height: 36 };

  const title = items.get("title");
  const dataTransfer = { effectAllowed: null, dropEffect: null, data: new Map(), setData(k, v) { this.data.set(k, v); } };

  w.storage.resetLog();
  w.list.dispatch("dragstart", { target: title.querySelector(".drag-glyph"), dataTransfer });
  assert.equal(dataTransfer.effectAllowed, "move");
  assert.ok(title.classList.contains("dragging"));

  w.list.dispatch("dragover", { target: items.get("album").down, clientY: 80 + 10, dataTransfer });
  assert.deepEqual(w.listOrder(), ["artist", "title", "album", ...FIELDS.slice(3)]);

  w.list.dispatch("dragover", { target: items.get("time").down, clientY: 8 * 40 + 35, dataTransfer });
  const finalOrder = [...FIELDS.slice(1), "title"];
  assert.deepEqual(w.listOrder(), finalOrder);

  w.list.dispatch("drop", { target: title, dataTransfer });
  w.list.dispatch("dragend", {});

  assert.ok(!title.classList.contains("dragging"));
  const writes = w.storage.writesTo(FIELD_ORDER_KEY);
  assert.equal(writes.length, 1, "an entire drag gesture must persist exactly once, on dragend");
  assert.equal(writes[0].op, "setItem");
  assert.deepEqual(JSON.parse(writes[0].value), finalOrder);
  assert.equal(w.storage.calls.some((c) => c.op === "removeItem"), false);

  for (const id of ["deck1Card", "deck2Card"]) {
    const orders = w.deckOrderByStyle(id);
    assert.equal(orders.artist, 0);
    assert.equal(orders.title, FIELDS.length - 1);
  }

  const first = w.controls.get(finalOrder[0]);
  const last = w.controls.get(finalOrder.at(-1));
  const mid = w.controls.get(finalOrder[3]);
  assert.equal(first.up.disabled, true);
  assert.equal(first.up.getAttribute("aria-disabled"), "true");
  assert.equal(first.down.disabled, false);
  assert.equal(first.down.getAttribute("aria-disabled"), "false");
  assert.equal(last.down.disabled, true);
  assert.equal(last.down.getAttribute("aria-disabled"), "true");
  assert.equal(last.up.disabled, false);
  assert.equal(last.up.getAttribute("aria-disabled"), "false");
  assert.equal(mid.up.getAttribute("aria-disabled"), "false");
  assert.equal(mid.down.getAttribute("aria-disabled"), "false");

  const before = w.listOrder();
  w.list.dispatch("dragover", { target: items.get("album").down, clientY: 90, dataTransfer });
  assert.deepEqual(w.listOrder(), before);
});

test("dragstart from interactive controls is suppressed; handle and bare row still drag", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();

  const album = w.api.findFieldElement(w.list, "album");
  album.rect = { top: 80, height: 36 };
  const dataTransfer = { effectAllowed: null, dropEffect: null, data: new Map(), setData(k, v) { this.data.set(k, v); } };
  const interactiveTargets = [
    ["checkbox", album.querySelector("input")],
    ["label", album.querySelector("label")],
    ["controls span", album.querySelector(".sortable-controls")],
    ["move button", w.controls.get("album").up],
  ];
  for (const [name, target] of interactiveTargets) {
    const evt = w.list.dispatch("dragstart", { target, dataTransfer });
    assert.equal(evt.defaultPrevented, true, `dragstart on ${name} must be prevented`);
    assert.ok(!album.classList.contains("dragging"), `dragstart on ${name} must not mark the row dragging`);
    assert.equal(dataTransfer.effectAllowed, null, `dragstart on ${name} must not configure a drag`);
    w.list.dispatch("dragend", {});
    assert.equal(w.storage.calls.length, 0, `suppressed ${name} drag must never persist`);
  }

  const orderBefore = w.listOrder();
  w.list.dispatch("dragover", { target: album.querySelector(".drag-glyph"), clientY: 90, dataTransfer });
  w.list.dispatch("drop", { target: album, dataTransfer });
  assert.deepEqual(w.listOrder(), orderBefore);
  assert.equal(w.storage.calls.length, 0);

  const glyphEvt = w.list.dispatch("dragstart", { target: album.querySelector(".drag-glyph"), dataTransfer });
  assert.equal(glyphEvt.defaultPrevented, false, "the decorative handle must keep native dragging");
  assert.ok(album.classList.contains("dragging"));
  assert.equal(dataTransfer.effectAllowed, "move");
  w.list.dispatch("dragend", {});
  assert.ok(!album.classList.contains("dragging"));

  const rowEvt = w.list.dispatch("dragstart", { target: album, dataTransfer });
  assert.equal(rowEvt.defaultPrevented, false, "the non-interactive row area must keep native dragging");
  assert.ok(album.classList.contains("dragging"));
  w.list.dispatch("dragend", {});
});

test("dragover and drop are always cancelled inside the list but never mutate or persist without an active internal drag", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();

  const album = w.api.findFieldElement(w.list, "album");
  const orderBefore = w.listOrder();
  w.storage.resetLog();

  const overEvt = w.list.dispatch("dragover", { target: album.querySelector(".drag-glyph"), clientY: 90 });
  assert.equal(overEvt.defaultPrevented, true, "external dragover must still be cancelled");
  const dropEvt = w.list.dispatch("drop", { target: album });
  assert.equal(dropEvt.defaultPrevented, true, "external drop must still be cancelled");
  const endEvt = w.list.dispatch("dragend", {});
  assert.notEqual(endEvt, undefined);

  assert.deepEqual(w.listOrder(), orderBefore, "no active internal drag means zero mutation");
  assert.equal(w.storage.calls.length, 0, "no active internal drag means zero persistence");
});

test("move actions announce concise English results without leaking storage internals", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();
  const status = w.elements.fieldSortableStatus;
  const leakFree = (text) => assert.doesNotMatch(text, /storage|quota|exception|error|localstorage/i);

  assert.equal(status.textContent, "");
  w.list.dispatch("click", { target: w.controls.get("title").down });
  assert.equal(status.textContent, "Title moved down to position 2");
  leakFree(status.textContent);

  w.list.dispatch("keydown", { target: w.controls.get("title").up, key: "ArrowUp" });
  assert.equal(status.textContent, "Title moved up to position 1");
  leakFree(status.textContent);

  w.list.dispatch("keydown", { target: w.controls.get("realtimebpm").down, key: "ArrowDown" });
  assert.equal(status.textContent, "Realtime BPM moved down to position 8");

  const blockedText = status.textContent;
  const blockedClick = w.list.dispatch("click", { target: w.controls.get("time").down });
  assert.equal(blockedClick.defaultPrevented, false);
  assert.equal(status.textContent, blockedText, "blocked moves must not fake an announcement");

  w.api.resetSortableFields();
  assert.equal(status.textContent, "Field order reset to defaults");
  leakFree(status.textContent);

  const items = new Map(w.list.querySelectorAll(".sortable-item").map((el) => [el.getAttribute("data-field"), el]));
  let index = 0;
  for (const f of FIELDS) items.get(f).rect = { top: index++ * 40, height: 36 };
  const dataTransfer = { effectAllowed: null, dropEffect: null, data: new Map(), setData() {} };
  w.list.dispatch("dragstart", { target: items.get("title").querySelector(".drag-glyph"), dataTransfer });
  w.list.dispatch("dragover", { target: items.get("time").down, clientY: 8 * 40 + 35, dataTransfer });
  w.list.dispatch("dragend", {});
  assert.equal(status.textContent, "Title moved to position 9");
  leakFree(status.textContent);
});

test("keyboard ArrowUp and ArrowDown on move controls reorder and persist; other keys are ignored", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();

  const evt = w.list.dispatch("keydown", { target: w.controls.get("artist").up, key: "ArrowUp" });
  assert.equal(evt.defaultPrevented, true);
  assert.deepEqual(w.listOrder()[0], "artist");
  assert.deepEqual(JSON.parse(w.storage.getItem(FIELD_ORDER_KEY))[0], "artist");

  w.list.dispatch("keydown", { target: w.controls.get("artist").down, key: "ArrowDown" });
  assert.deepEqual(w.listOrder(), FIELDS);

  const last = w.api.findFieldElement(w.list, "time");
  const lastDown = last.querySelectorAll('[data-move="down"]')[0];
  w.list.dispatch("keydown", { target: lastDown, key: "ArrowDown" });
  assert.deepEqual(w.listOrder(), FIELDS);

  const ignored = w.list.dispatch("keydown", { target: w.controls.get("title").up, key: "Enter" });
  assert.equal(ignored.defaultPrevented, false);
  assert.deepEqual(w.listOrder(), FIELDS);
});

test("saved order must be an exact permutation of DEFAULT_FIELD_ORDER", () => {
  const invalidCases = [
    ["duplicate field", JSON.stringify(["title", "artist", "artist", "album", "genre", "key", "label", "realtimebpm", "trackbpm"])],
    ["unknown field", JSON.stringify(["title", "artist", "album", "genre", "key", "label", "realtimebpm", "trackbpm", "coverart"])],
    ["subset of fields", JSON.stringify(["time", "key"])],
  ];
  for (const [name, raw] of invalidCases) {
    const w = loadOrderingModule(raw);
    w.api.initSortableFields();
    assert.deepEqual(w.listOrder(), FIELDS, `${name} must fail closed to the default order`);
    const expected = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
    for (const id of ["deck1Card", "deck2Card"]) {
      assert.deepEqual(w.deckOrderByStyle(id), expected, `${name} deck order must be default`);
    }
  }

  const valid = [...FIELDS].reverse();
  const w = loadOrderingModule(JSON.stringify(valid));
  w.api.initSortableFields();
  assert.deepEqual(w.listOrder(), valid);
  for (const id of ["deck1Card", "deck2Card"]) {
    const orders = w.deckOrderByStyle(id);
    valid.forEach((field, index) => {
      assert.equal(orders[field], index);
    });
  }
});

test("first Up and last Down controls are disabled with synced aria state at init and after every reorder", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();

  let first = w.controls.get(w.listOrder()[0]);
  let last = w.controls.get(w.listOrder().at(-1));
  assert.equal(first.up.disabled, true);
  assert.equal(first.up.getAttribute("aria-disabled"), "true");
  assert.equal(last.down.disabled, true);
  assert.equal(last.down.getAttribute("aria-disabled"), "true");
  assert.equal(first.down.disabled, false);
  assert.equal(first.down.getAttribute("aria-disabled"), "false");
  assert.equal(last.up.disabled, false);
  assert.equal(last.up.getAttribute("aria-disabled"), "false");

  w.list.dispatch("click", { target: w.controls.get("title").down });
  let order = w.listOrder();
  assert.deepEqual(order[0], "artist");
  first = w.controls.get(order[0]);
  last = w.controls.get(order.at(-1));
  assert.equal(first.up.disabled, true);
  assert.equal(w.controls.get("title").up.disabled, false);
  assert.equal(w.controls.get("title").up.getAttribute("aria-disabled"), "false");
  assert.equal(last.down.disabled, true);
  assert.equal(last.down.getAttribute("aria-disabled"), "true");

  w.list.dispatch("click", { target: w.controls.get("time").up });
  order = w.listOrder();
  assert.equal(order.at(-1), "trackbpm");
  assert.equal(w.controls.get("trackbpm").down.disabled, true);
  assert.equal(w.controls.get("trackbpm").down.getAttribute("aria-disabled"), "true");
  assert.equal(w.controls.get("time").down.disabled, false);
  assert.equal(w.controls.get("time").down.getAttribute("aria-disabled"), "false");

  const blocked = w.list.dispatch("keydown", { target: w.controls.get("trackbpm").down, key: "ArrowDown" });
  assert.deepEqual(w.listOrder(), order);
  assert.equal(blocked.defaultPrevented, false);
});

test("resetSortableFields clears persistence, restores default order, resyncs controls, and reuses row nodes", () => {
  const custom = ["artist", "title", ...FIELDS.slice(2)];
  const w = loadOrderingModule(JSON.stringify(custom));
  w.api.initSortableFields();
  assert.equal(w.controls.get("artist").up.disabled, true);

  const titleNodeBefore = w.api.findFieldElement(w.list, "title");
  w.storage.resetLog();
  w.api.resetSortableFields();

  assert.equal(w.storage.getItem(FIELD_ORDER_KEY), null);
  const removes = w.storage.calls.filter((c) => c.op === "removeItem" && c.key === FIELD_ORDER_KEY);
  assert.equal(removes.length, 1, "reset must remove the persisted order exactly once");
  assert.deepEqual(w.listOrder(), FIELDS);
  assert.equal(w.api.findFieldElement(w.list, "title"), titleNodeBefore, "reset must reuse the same row nodes so focus survives");
  assert.equal(w.controls.get("title").up.disabled, true);
  assert.equal(w.controls.get("title").up.getAttribute("aria-disabled"), "true");
  assert.equal(w.controls.get("time").down.disabled, true);
  assert.equal(w.controls.get("time").down.getAttribute("aria-disabled"), "true");
  assert.equal(w.controls.get("title").down.disabled, false);
  const expected = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
  for (const id of ["deck1Card", "deck2Card"]) {
    assert.deepEqual(w.deckOrderByStyle(id), expected);
  }
});

test("initSortableFields is idempotent and never stacks duplicate listeners", () => {
  const w = loadOrderingModule(undefined);
  w.api.initSortableFields();
  const listenerCounts = () =>
    Object.fromEntries(
      ["dragstart", "dragover", "drop", "dragend", "click", "keydown"].map((type) => [
        type,
        (w.list.listeners[type] || []).length,
      ]),
    );
  const afterFirstInit = listenerCounts();
  for (const count of Object.values(afterFirstInit)) {
    assert.equal(count, 1);
  }

  w.api.initSortableFields();
  w.api.initSortableFields();
  assert.deepEqual(listenerCounts(), afterFirstInit);

  w.list.dispatch("click", { target: w.controls.get("title").down });
  assert.deepEqual(w.listOrder(), ["artist", "title", ...FIELDS.slice(2)]);
  assert.deepEqual(JSON.parse(w.storage.getItem(FIELD_ORDER_KEY)), w.listOrder());
  for (const item of w.list.querySelectorAll("[data-field]")) {
    assert.equal(item.getAttribute("draggable"), "true");
  }
});
