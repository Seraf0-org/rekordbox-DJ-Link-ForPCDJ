"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");

const { createHookUdpProvider } = require("../server/providers/hookUdpProvider");

const {
  applyDeckTrackLoadIdentity,
  applyNowPlayingIdentityPatch,
  isDefiniteContentIdentityReplacement,
} = require("../server/trackIdentityTransition");

test("content identity replacement is exact and does not confuse enrichment or replay", () => {
  assert.equal(isDefiniteContentIdentityReplacement("old", "new"), true);
  assert.equal(isDefiniteContentIdentityReplacement("same", "same"), false);
  assert.equal(isDefiniteContentIdentityReplacement(null, "late-id"), false);
  assert.equal(isDefiniteContentIdentityReplacement("old", null), false);
  assert.equal(isDefiniteContentIdentityReplacement(" 42", "42"), true);
});

test("a different track_load ID clears prior deck metadata before publishing the new identity", () => {
  const deck = {
    trackBrowserId: 100,
    title: "Old title",
    artist: "Old artist",
    album: "Old album",
    key: "Gm",
    originalBpm: 14_000,
    trackNo: 7,
    metadata: { old: true },
    currentTime: 2_000,
  };

  assert.equal(applyDeckTrackLoadIdentity(deck, 200), true);
  assert.equal(deck.trackBrowserId, 200);
  assert.equal(deck.title, null);
  assert.equal(deck.artist, null);
  assert.equal(deck.album, null);
  assert.equal(deck.key, null);
  assert.equal(deck.originalBpm, null);
  assert.equal(deck.trackNo, null);
  assert.deepEqual(deck.metadata, {});
  assert.equal(deck.currentTime, 2_000, "transport observation remains independent");
});

test("same-ID replay and first content-ID enrichment preserve current deck text", () => {
  const replay = { trackBrowserId: 200, title: "Demo Track 2", artist: "Loopmasters" };
  assert.equal(applyDeckTrackLoadIdentity(replay, 200), false);
  assert.deepEqual(replay, {
    trackBrowserId: 200,
    title: "Demo Track 2",
    artist: "Loopmasters",
  });

  const enrichment = { title: "Text arrived first", artist: "Artist" };
  assert.equal(applyDeckTrackLoadIdentity(enrichment, 300), false);
  assert.deepEqual(enrichment, {
    trackBrowserId: 300,
    title: "Text arrived first",
    artist: "Artist",
  });
});

test("now-playing patch drops old track fields only for a definite ID replacement", () => {
  const old = {
    contentId: "100",
    title: "Old title",
    artist: "Old artist",
    album: "Old album",
    key: "Gm",
    durationSec: 306.31,
    trackBpm: 140,
    source: "rekordbox-hook-live",
  };
  assert.deepEqual(applyNowPlayingIdentityPatch(old, {
    contentId: "200",
    source: "rekordbox-hook",
  }), {
    contentId: "200",
    title: null,
    artist: null,
    album: null,
    genre: null,
    key: null,
    label: null,
    origArtist: null,
    remixer: null,
    composer: null,
    comment: null,
    mixName: null,
    lyricist: null,
    waveform: null,
    durationSec: null,
    trackNo: null,
    trackBpm: null,
    source: "rekordbox-hook",
  });

  assert.deepEqual(applyNowPlayingIdentityPatch(old, { contentId: "100" }), old);
  assert.deepEqual(
    applyNowPlayingIdentityPatch({ title: "Text first", artist: "Artist" }, { contentId: "300" }),
    { title: "Text first", artist: "Artist", contentId: "300" }
  );
});

test("hook snapshots never pair a replacement content ID with the prior track text", async (t) => {
  const provider = createHookUdpProvider({ enabled: true, port: 0 });
  const snapshots = [];
  provider.on("snapshot", (snapshot) => snapshots.push(snapshot));
  t.after(() => provider.stop());

  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hook provider did not bind")), 1_000);
    provider.on("status", (status) => {
      if (status.ok === false) {
        clearTimeout(timer);
        reject(new Error(status.message || "Hook provider failed to bind"));
        return;
      }
      if (status.message?.includes("listener started") && Number.isInteger(status.port) && status.port > 0) {
        clearTimeout(timer);
        resolve(status.port);
      }
    });
  });
  provider.start();
  const actualPort = await started;

  const sender = dgram.createSocket("udp4");
  t.after(() => sender.close());
  const send = (packet) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(packet));
    sender.send(body, actualPort, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });

  await send({ type: "track_load", deck: 1, contentId: 100 });
  await send({ type: "track_meta", deck: 1, title: "Old title", artist: "Old artist" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    snapshots.at(-1).deckNowPlaying.map(({ contentId, title, artist }) => ({ contentId, title, artist })),
    [{ contentId: "100", title: "Old title", artist: "Old artist" }]
  );

  const beforeReplacement = snapshots.length;
  await send({ type: "track_load", deck: 1, contentId: 200 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const replacementSnapshots = snapshots.slice(beforeReplacement);
  assert.ok(replacementSnapshots.length > 0);
  assert.equal(
    replacementSnapshots.some((snapshot) => snapshot.deckNowPlaying.some((entry) =>
      entry.contentId === "200" && (entry.title === "Old title" || entry.artist === "Old artist")
    )),
    false,
    "no replacement snapshot may combine the new ID with prior text"
  );
  assert.deepEqual(
    replacementSnapshots.at(-1).deckNowPlaying.map(({ contentId, title, artist }) => ({ contentId, title, artist })),
    [{ contentId: "200", title: null, artist: null }]
  );

  await send({ type: "track_meta", deck: 1, title: "Demo Track 2", artist: "Loopmasters" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    snapshots.at(-1).deckNowPlaying.map(({ contentId, title, artist }) => ({ contentId, title, artist })),
    [{ contentId: "200", title: "Demo Track 2", artist: "Loopmasters" }]
  );

  const assertReplacement = (replacementSnapshots, contentId, priorTitle, priorArtist) => {
    assert.ok(replacementSnapshots.length > 0);
    assert.equal(
      replacementSnapshots.some((snapshot) => snapshot.deckNowPlaying.some((entry) =>
        entry.contentId === contentId && (entry.title === priorTitle || entry.artist === priorArtist)
      )),
      false,
      `no ${contentId} snapshot may combine the replacement ID with prior text`
    );
    assert.deepEqual(
      replacementSnapshots.at(-1).deckNowPlaying.map(({ contentId: id, title, artist }) => ({
        contentId: id,
        title,
        artist,
      })),
      [{ contentId, title: null, artist: null }]
    );
  };

  // Invalid IDs are ignored and must not clear the currently trusted text.
  await send({ type: "olvc", deck: 1, name: "@TrackBrowserID", value: 0 });
  await send({ type: "olvc", deck: 1, name: "@ContentID", value: -1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    snapshots.at(-1).deckNowPlaying.map(({ contentId, title, artist }) => ({ contentId, title, artist })),
    [{ contentId: "200", title: "Demo Track 2", artist: "Loopmasters" }]
  );

  const beforeOlvcReplacement = snapshots.length;
  await send({ type: "olvc", deck: 1, name: "@TrackBrowserID", value: 300 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertReplacement(snapshots.slice(beforeOlvcReplacement), "300", "Demo Track 2", "Loopmasters");

  await send({ type: "track_meta", deck: 1, title: "Track Browser 300", artist: "Artist 300" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeGenericOlvcReplacement = snapshots.length;
  await send({ type: "olvc", deck: 1, name: "@ContentID", value: 400 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertReplacement(
    snapshots.slice(beforeGenericOlvcReplacement),
    "400",
    "Track Browser 300",
    "Artist 300"
  );

  await send({ type: "track_meta", deck: 1, title: "Demo Track 2", artist: "Loopmasters" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    snapshots.at(-1).deckNowPlaying.map(({ contentId, title, artist }) => ({ contentId, title, artist })),
    [{ contentId: "400", title: "Demo Track 2", artist: "Loopmasters" }]
  );
});
