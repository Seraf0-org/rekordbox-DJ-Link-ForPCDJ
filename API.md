# rb-output API

The server listens on `http://<host>:8787` by default. The API is read-only and
does not require authentication, so it can be consumed by another computer or
music application on the LAN.

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
