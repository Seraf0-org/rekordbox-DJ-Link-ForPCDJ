# Syndocal / Pedal handoff contract

この文書は、Syndocal側と`rb-output`側を別担当で接続するための実装契約です。

## 権威ソースとwire契約(2026-08更新)

KDMX/Syndocalの権威実装(`crates/protocol/src/lib.rs`の`DjLinkEnvelope`/
`DjLinkFlatFrame`/`DjLinkAck`、`crates/io/src/remote_ws.rs`の
`handle_dj_link_client`)を照合し、次の2つのwire契約が証明されています。
どちらも`/dj-link`パス専用のWebSocketで、認証は (1) HTTP Host/Origin検証と
(2) HELLO内トークンの定数時間比較の2面で行われます。Authorizationヘッダは
無視されます。

- `generic-json`(既定): フラットframe。HELLOのみ
  `{type,eventId,sequence,protocol:"generic-json",token,capabilities}`を
  持ち、それ以外はpayloadがルートに展開されます。ACKは8フィールド固定
  (`type,eventId,ok,message,outcome,sequence,code,stateGeneration`)です。
  flat wireでは`DJ_TIMELINE_STATE_REQUEST`以降の送信前にsnapshotが要求され
  ます(SnapshotRequired)。
- `syndocal-envelope-v1`: レガシーv1 envelope。全frameが
  `{v:1,type,agentId,sessionId,sequence,eventId,payload}`で、HELLO payloadは
  `{authToken,version:1,capabilities}`、ACKは7フィールド固定
  (`v,type,eventId,sequence,outcome,code,stateGeneration`、ok/messageは
  付与されません)、`DJ_TIMELINE_STATE`はpayload内に
  `{state,loopActive,timelineId,positionBars}`を持ちます。全frameでHELLOと
  同じagentId/sessionIdが必要で、不一致は`session_mismatch`拒否、同一形状の
  HELLO再送はDuplicate扱いで切断されるため、再接続ごとに新しいsessionIdを
  発行します。envelope wireにはsnapshot前提の順序制約はありません
  (LegacyV1Direct)。ただしrb-output側は両adapterで接続後の権威snapshot待ち
  gate(fail-closed)を維持します。

共通の検証境界: frameは64KiB以下、文字列は1..256バイトかつ制御文字なし、
sequenceは1..=9_007_199_254_740_991、トークンは32..256バイト、capabilitiesは
32個以下、loop divisionは0..=63、beat jump barsは-4/4のみ、trackBpmは
0..=1000。不正・未知frameは`rejected` ACK(code付き)または無視+warningと
なり、成功扱いしません。冪等性はeventId単位で、再送は`duplicate`、保持期間
外の再送は`event_id_not_retained`、sequence巻き戻りは`sequence_rollback`、
処理中は`busy`(`in_flight`)が返ります。busyは有限回の指数バックオフ再試行
で回復します。

adapter名は明示設定のみで、未設定・未知名は利用不可(fail-closed)であり、
generic-jsonへの黙ってフォールバックはしません。

## 接続と状態同期

WebSocket接続後、クライアントは順に`DJ_AGENT_HELLO`、`DJ_STATE_SYNC`、
`DJ_TIMELINE_STATE_REQUEST`を送信します。再接続・再起動後も同じ順序で、
Syndocalは現在の権威状態を`DJ_TIMELINE_STATE`で返してください。状態が返る
まではtimeline actionを送らず、`timeline-control`中の切断は`dj-control`へ
自動復帰しません（安全側に停止します）。

`DJ_TIMELINE_STATE`の最小形式は次です。

```json
{
  "type": "DJ_TIMELINE_STATE",
  "eventId": "timeline-state-42",
  "sequence": 42,
  "state": "running",
  "loopActive": false,
  "timelineId": "show-2026-08-21",
  "positionBars": 128
}
```

`state`は`idle`、`running`、`stopped`、`ended`、`reset`のいずれか、
`loopActive`はbooleanです。`syndocal-envelope-v1`では同じ内容が
`{v:1,type:"DJ_TIMELINE_STATE",agentId,sessionId,sequence,eventId,
payload:{state,loopActive,timelineId,positionBars}}`のpayload内に
入ります。不正値・未知の`DJ_TIMELINE_*`は無視しwarningに
します。`running`を受信した時だけ`dj-control`から`timeline-control`へ入り、
`idle`/`stopped`/`ended`/`reset`で`dj-control`へ戻ります。F13での
`DJ_RELEASE`受理だけではtimelineへ切り替わりません。
Syndocal handoffを有効にした初期接続中、接続後snapshot待ち、切断中、再接続
直後は、`timelineSnapshotReady`がfalseのためStage 1のF13/F14/F15も
fail-closedです。この間はrekordbox MIDIを送信せず、snapshotを受信して
`idle`/`stopped`/`ended`/`reset`が確定してからStage 1を許可します。
Syndocalを無効にしたローカル専用構成ではこのgateはなく、既存MIDI操作を
継続します。

## Stage 1: Rekordbox操作とhandoff

設定例で明示的にrelease macroを有効にした場合、既定の
`sequence:"parallel"`ではF13がmaster deckに対してFilter HP（64→127）と
deck別`ChannelFader`（127→0）を独立タイマーで1000ms並行rampします。
`sequence:"filter-then-fade"`を選ぶと、Filter HP rampが完全成功するまで
ChannelFaderは一通も送らず、その後に1000ms fadeを開始します。Filterと
fadeの両方が成功した後だけCue/Stopを送り、停止中にFilter 64 / Fader 127
へresetし、最後に`DJ_RELEASE`を送って`handoff-pending`へ移ります。
Filter failureではfade/Stop/Releaseを開始せず、fade failureではStop/
Releaseを開始せず、安全に可能なFilter resetを試行して結果を表示します。
片方のramp、Stop、resetが失敗した場合も後続のStop/Releaseを成功扱いに
せず、failure/warningを表示します。API/statusとaction resultには
`sequence`（`parallel`/`filter-then-fade`）と`phase`
（`filter-ramp`、`parallel-ramp`、`fade-ramp`、`stopping`、`resetting`、
`handoff-pending`、`complete`、`failed`）を保持します。
失敗時は`releaseMacroReason`と`lastAction.reason`に同じrampまたはACKの
理由を保持し、DJ_RELEASEのcanonical eventIdに紐付いたdelivery更新で
phase/status/UIを同時に更新します。authoritative `running`を受信した後の
遅延reject/timeoutは既に確定した`complete`を巻き戻しません。
F14は従来のLoopHalf、F15はStage 1ではinactive（MIDIもSyndocalも送信
しない）です。macro未設定時は既存互換の直接Stop/Release経路になります。

推奨Learn例（CustomMIDI1、1-based channel）は次です。

| 用途 | Deck 1 | Deck 2 |
| --- | --- | --- |
| LoopHalf | CH1 Note36 (`0x90 0x24 0x7f`) | `deckChannels`設定時CH2 Note36 (`0x91 0x24 0x7f`) |
| Cue/Stop | CH1 Note37 (`0x90 0x25 0x7f`) | `deckChannels`設定時CH2 Note37 (`0x91 0x25 0x7f`) |
| Filter HP | CH1 CC16 (`B010`) | `deckChannels`設定時CH2 CC16 (`B110`) |
| ChannelFader fade | CH1 CC17 (`B011`) | `deckChannels`設定時CH2 CC17 (`B111`) |

Rekordbox標準CSVにもdeck別`ChannelFader`（例：
`ChannelFader,,KnobSlider,,B011,B111,...`）があるため、既定例はglobal
MasterLevelではなくChannelFaderです。実機のLearn結果が異なる場合は
設定のmapping/channelを変更し、推測で別CCへ切り替えないでください。

## Stage 2: timeline control

`running`後は物理キーを次へ切り替えます。すべてACK対象で、Stage 2では
Rekordbox MIDIを一切呼びません。

| Pedal | outbound | payload |
| --- | --- | --- |
| F13 | `DJ_TIMELINE_BEAT_JUMP` | `{ "bars": -4, "timelineId": "..." }` |
| F14 | `DJ_TIMELINE_LOOP_SET` | `{ "active": true|false, "timelineId": "..." }` |
| F15 | `DJ_TIMELINE_BEAT_JUMP` | `{ "bars": 4, "timelineId": "..." }` |

F14は前回の権威`loopActive`を反転した絶対値を送ります。送信中は次の
toggleを保留し、rejected/timed-out/send-failedなら保留値を破棄します。
ACK成功だけで権威状態を書き換えず、次の`DJ_TIMELINE_STATE` broadcastを
待ちます。time signatureとbar gridはSyndocal側が決定し、`bars`は音楽的な
小節数（秒数ではない）です。

## eventId / ACK / 順序

すべての送信eventに一意eventIdと単調増加sequenceを付けます。受信側は
eventIdで冪等処理し、同じIDを二重適用しません。generic-json(flat) wireの
ACKは次の8フィールド固定形です。

```json
{
  "type": "ACK",
  "eventId": "...",
  "ok": true,
  "message": "accepted",
  "outcome": "accepted",
  "sequence": 42,
  "code": null,
  "stateGeneration": 7
}
```

`syndocal-envelope-v1` wireでは`v:1`が先頭に付き、`ok`/`message`は付与され
ず、7フィールド(`v,type,eventId,sequence,outcome,code,stateGeneration`)固定
です。`outcome`は`accepted`/`duplicate`/`no_mapping`/`rejected`/`busy`で、
`accepted`と`duplicate`のみ成功扱いです。それ以外の形式・未知outcomeは
拒否しwarningにします。

送信直後は`pending`であり、`ok:true`ではありません。最終deliveryは
`acknowledged`、`rejected`、`timed-out`、`send-failed`のいずれかです。
UI/APIはpending・success・failureを同じaction eventIdで表示します。

典型的な順序は次です。

1. `DJ_RELEASE`受理（ただしmodeはまだ`handoff-pending`）。
2. Syndocalがtimelineを開始。
3. `DJ_TIMELINE_STATE(state:"running")`をbroadcast。
4. `timeline-control`へ切替後、F13/F14/F15を送信。
5. 終演・停止・resetを`DJ_TIMELINE_STATE`でbroadcastし、`dj-control`へ戻す。

切断・ACK timeout・不正state・bar grid不一致は成功扱いにせず、warningと
last deliveryに残してください。物理機器未接続でもNode本体は継続起動し、
必要な境界だけ`unavailable`/`send-failed`になります。
