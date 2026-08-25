# rb-output API

The server listens on `http://<host>:8787` by default. The core state API is
read-only and does not require authentication, so it can be consumed by
another computer or music application on the LAN. The separately gated DJ
Agent diagnostic action routes are local control endpoints and are available
only when the extension is explicitly enabled.

## Current state

`GET /api/now-playing` (also available as `GET /api/state`) returns the complete
snapshot used by the web UI. The loop-only endpoint is:

```http
GET /api/loops
```

Response:

```json
{
  "loopStates": [
    {
      "deck": 1,
      "active": true,
      "startMs": 32000,
      "endMs": 40000,
      "startBeat": 16,
      "endBeat": 20,
      "lengthBeats": 4,
      "updatedAt": "2026-08-19T12:00:00.000Z",
      "source": "rekordbox-hook"
    }
  ],
  "loops": [
    {
      "deck": 1,
      "active": true,
      "startMs": 32000,
      "endMs": 40000,
      "startBeat": 16,
      "endBeat": 20,
      "lengthBeats": 4,
      "updatedAt": "2026-08-19T12:00:00.000Z",
      "source": "rekordbox-hook"
    }
  ],
  "updatedAt": "2026-08-19T12:00:00.000Z"
}
```

`loops` is an alias for `loopStates` for clients that prefer a shorter name.
`GET /api/loop-state` is an equivalent compatibility route. When a loop is
not active, the server publishes `active: false`; the last known boundaries are
retained so a client can render the transition cleanly.

## Server-Sent Events

`GET /api/stream` (or the compatibility alias `GET /api/events`) provides a
standard SSE stream. It sends an initial `state` event, followed by `state`
events whenever the snapshot changes and a `loop_state` event whenever a loop
changes.

```js
const source = new EventSource("http://127.0.0.1:8787/api/stream");
source.addEventListener("loop_state", (event) => {
  const loop = JSON.parse(event.data);
  console.log(loop.deck, loop.active, loop.lengthBeats);
});
```

## Socket.IO

The existing `state` event remains backward compatible and now includes a
`loopStates` array. In addition, the server emits a `loop_state` event with one
normalized object per update. On connection, the current loop state is replayed
once for each known deck.

## DJ Agent extension

The DJ Agent extension is disabled unless DJ_AGENT_ENABLED=true or a JSON
file with "enabled": true is supplied through DJ_AGENT_CONFIG_PATH. When
disabled, `GET /api/dj-agent/status` still returns HTTP 200 with
`enabled:false`; the POST action routes return 404 and the existing APIs
remain unchanged.

GET /api/dj-agent/status reports the optional Syndocal, MIDI, and pedal
adapter states. The diagnostic action routes use the same router as the
physical pedal:

* POST /api/dj-agent/actions/loop-half
* POST /api/dj-agent/actions/filter-close
* POST /api/dj-agent/actions/release
* POST /api/dj-agent/actions/track-active

When configured, `midi.deckChannels` maps a one-based Rekordbox deck to a MIDI
channel, for example `{ "1": 1, "2": 2 }`. The current detector master deck
selects the channel for loop-half, release, and every filter-ramp CC message;
an unmapped deck falls back to the mapping's configured `channel`. Action
results and `DJ_LOOP_STATE`/`DJ_RELEASE` payloads expose `targetDeck` and
`targetChannel`. The equivalent environment override is the JSON-valued
`MIDI_DECK_CHANNELS` variable.

POST actions are loopback-only by default. IPv4 `127.0.0.0/8`, IPv4-mapped
IPv6 loopback, and `::1` are accepted. A remote request receives HTTP 403 unless
`DJ_AGENT_ALLOW_REMOTE_ACTIONS=true` is explicitly configured. The read-only
status route remains remotely readable.

For actions that send `DJ_RELEASE`, HTTP 202 with
`ok:false`/`ackState:"pending"` means the local action was sent and is waiting
for a Syndocal ACK. ACK `ok:false`, timeout, disconnected send, and local MIDI
failure remain failures; they are never reported as `ok:true` merely because a
send call returned. Stage 1 loop-half is local MIDI only. Network
`DJ_LOOP_STATE` frames come exclusively from measured hook loop packets and
carry active/startBeat/endBeat/lengthBeats plus revision and freshness.

Track activity is derived from Hook UDP snapshots and explicit master_change
packets. DJ_TRACK_LOADED remains diagnostic. DJ_MASTER_TRACK_ACTIVE is delayed
until one play session has an exact master deck, exact track identity,
positionAtSendSec, effectiveBpm, a monotonic positionRevision, and a sample no
older than 1500 ms. DJ_MASTER_TRACK_SYNC then carries later revisions for that
same session; missing, null, nonfinite, stale, duplicate, and reordered samples
fail closed. A nonempty contentId is authoritative; title+artist is used only
when contentId is absent.

The sole shipped/current/production adapter is `syndocal-envelope-v2`.
Every frame has exactly `{v:2,type,agentId,sessionId,sequence,eventId,payload}`.
Flat and v1 frames, retired adapter names, aliases, and unknown names are
rejected visibly; there is no compatibility adapter or fallback. The transport
provides reconnect, heartbeat, event IDs, monotonically increasing wire
sequence values, ACK tracking, and DJ_STATE_SYNC. An unacknowledged physical
event is retried after reconnect with the same eventId and semantic payload
(including playSessionId), a fresh connection sessionId, and a new monotonic
wire sequence; duplicate ACK outcome is success.
`DJ_MASTER_TRACK_SYNC` is non-ACK continuous telemetry: it uses an O(1)
connection-generation + wire-sequence eventId, never enters the durable
physical-event registry, and is never replayed after reconnect. A fresh sync
must arrive for the new connection/session; late frames stay socket-fenced.
When Syndocal is disabled, local-only MIDI actions continue to work without a
network. When handoff is enabled, the initial connection, reconnection, and
disconnected interval are fail-closed until an authoritative timeline snapshot
is received; Stage 1 pedals send no Rekordbox MIDI while that snapshot is
pending. Stale pedal events are not replayed after reconnection.

`GET /api/dj-agent/status` also exposes the handoff state machine:
`mode` is `dj-control`, `handoff-pending`, or `timeline-control`; `timelineState`
is the last authoritative state (`idle`, `running`, `stopped`, `ended`, or
`reset`); `timelineLoopActive` is the authoritative loop value; and
`lastTimelineAction` contains the last Stage 2 action and its ACK delivery.
`releaseMacroSequence` is `parallel` or `filter-then-fade`, and
`releaseMacroPhase` reports `idle`, `filter-ramp`, `parallel-ramp`, `fade-ramp`,
`stopping`, `resetting`, `handoff-pending`, `complete`, or `failed`.
`releaseMacroReason` carries the terminal ramp/delivery failure reason when
the phase is `failed` (otherwise it is `null`), and `lastAction` is updated
with the same canonical release eventId, delivery state, phase, and reason.
`filter-then-fade` guarantees that the first ChannelFader MIDI message is
sent only after the Filter ramp completion callback; a Filter failure starts
no fade/Stop/Release, and a fade failure attempts Filter reset without
starting Stop/Release. `parallel` remains the backwards-compatible default.
Stage 1 F15 returns an explicit `ignored:true`, `state:"inactive"` result and
HTTP 200 so an intentional no-op is not rendered as a hardware/network error.

When Stage 2 is active, the pedal aliases are:

* F13 / `release` → `DJ_TIMELINE_BEAT_JUMP` with `{ "bars": -4, "timelineId": "...", "playSessionId": "..." }`
* F14 / `loop-half` → `DJ_TIMELINE_LOOP_SET` with an absolute `{ "active": true|false, "timelineId": "...", "playSessionId": "..." }`
* F15 / `filter-close` → `DJ_TIMELINE_BEAT_JUMP` with `{ "bars": 4, "timelineId": "...", "playSessionId": "..." }`

Both commands stamp the authoritative snapshot's exact current `timelineId` and
`playSessionId`. Their encoders accept only those exact payload fields; any
unknown field fails closed, and the internal local-source marker
(`source:"pedal"`) is stripped so transmitted frames carry only canonical
fields. Authoritative `DJ_TIMELINE_STATE` frames are fenced within one session
by `sessionId` + `sequence`: stale/equal sequences are dropped without
mutation, and the fence re-keys on each new connection generation after a
reconnect instead of comparing across sessions. A skipped or terminally failed
(rejected/timed-out/send-failed) `DJ_TIMELINE_LOOP_SET` clears its pending
toggle latch immediately and stays retryable as a fresh absolute value on the
next F14 press.

`DJ_TIMELINE_STATE` is an exact v2 envelope. Its payload has exactly
`state`, `loopActive`, `timelineId`, `positionBars`, `playSessionId`,
`pedalOwner`, and `releaseEventId`. A generic `running` state never transfers
pedal ownership. `pedalOwner:"timeline"` is accepted only when playSessionId
matches the current show session and releaseEventId matches its correlated
DJ_RELEASE. Late sync for a released session is fenced and cannot reacquire
control. A connected client requests a fresh snapshot after hello and after
each reconnect. Timeline actions require that snapshot and a connected socket,
and use the same eventId/sequence/ACK delivery states as other action events.
The full Japanese integration contract is in
[`SYNDOCAL_PEDAL_HANDOFF.md`](SYNDOCAL_PEDAL_HANDOFF.md).

## Loop event contract

The native hook sends a JSON packet with `type: "loop_state"`. The server also
accepts the historical camel-case `loopState` and short `loop` packet names.
`deck` is one-based. All time values are milliseconds and all beat values are
floating-point beat positions. Optional values are `null` when unavailable.

```json
{
  "type": "loop_state",
  "deck": 1,
  "active": true,
  "startMs": 32000,
  "endMs": 40000,
  "startBeat": 16,
  "endBeat": 20,
  "lengthBeats": 4
}
```

The server normalizes common snake-case aliases (`start_ms`, `end_beat`, and
so on), derives `endBeat` or `lengthBeats` when enough information is present,
and maps physical decks 3/4 to the existing two-deck logical view in the same
way as the legacy hook events.
