# Syndocal / Pedal handoff contract

この文書は、Syndocal側と`rb-output`側を別担当で接続するための実装契約です。

## 2026-08-25 adapter権威reconciliation（docs-only）

監督laneの指示に基づく文書面の権威整理です。出荷・現行・productionの既定adapterは
flat `generic-json`であり、HELLO → 権威snapshot(`DJ_STATE_SYNC`) →
`DJ_TIMELINE_STATE_REQUEST`/timeline actionのsnapshot順序が必須で、違反は
SnapshotRequiredでfail-closedです。`syndocal-envelope-v1`は旧KDMX v1 envelope
wire向けの明示的なlegacy互換/診断用選択肢です。コード側の権威裏付けは、rb-output
`server/dj-agent/config.js` の未設定時既定値 `generic-json` と、KDMX
`crates/protocol/src/lib.rs` の `DjLinkFlatFrame`("The peer's final generic-json
adapter"、旧v1 envelopeは"kept separately for compatibility")です。

本日より前に本書とREADMEへ書き込まれた「production=`syndocal-envelope-v1`/
generic-json=互換・診断」という役割逆転の表記を、wire挙動を一切変更せずに修正しました
(API.mdの旧「generic-jsonのみ明示選択」「権威契約なし」記述も同期)。
heartbeat checkpoint、live DJ PC checkpoint、旧dist削除checkpointなど既存の記録と、
他ファイルのdirty/untracked状態は保持します。これはdocs-onlyの整理であり、本laneでは
commit/push/versionを行いません。物理LAN/MIDI/ペダル/Rekordbox/Syndocal ACKの
受入れ主張は含まず、HW-4マトリクス0/12と`Required / Peer and hardware pending`
は不変です。

## v1.1.2 first-run Setup契約 (2026-08-25)

DJ PCのSetup cardはDJ Agentがdisabled・未設定・native device未接続でも常時表示
されます。カードが読むのは `GET /api/dj-agent/setup` だけで、同APIはlocalhost専用
です。request peerのloopback、Hostのlocalhost/loopback、Originの空値または
localhost/loopbackをすべて満たす必要があり、Host/Origin/peerのいずれかが不成立なら
403で拒否します。LAN向けの通常status/read-only APIとSetup APIの公開境界は別です。

Setupはread-onlyであり、token input、token表示、localStorage保存、サーバー設定を
変更するPOSTを持ちません。config preview/download/copyもtoken-freeです。カードから
提供するversioned artifact
`CustomMIDI1-Syndocal-v1.1.2.csv` はoperatorがRekordboxのMIDI Learn/CustomMIDI1へ
手動importします。virtual MIDI driver、Rekordbox、Elgato/Stream Deckなど外部操作は
自動化せず、guided confirmationとして別途確認します。
カード上で案内する入力はSyndocal host、local NIC、MIDI output、adapterです。
CSVの検証済み要点は `CFXParameterCH1=B010`、`CFXParameterCH2=B110`、
`ChannelFader=B011/B111`、`Cue=9025/9125`、`LoopHalf=9024/9124`です。

MIDI outputは列挙結果の同一optionについて、非空device nameとsafe integer portが
一致した時だけ既存選択を反映します。`null`、空、boolean、数値文字列をseedせず、
port 0を暗黙選択しません。adapterは初回必ず未選択です。device/portは既存設定が
あり、列挙結果のname+portへ完全一致する場合だけ反映し、それ以外は未選択にします。
operatorがこのページで明示選択した後だけpreviewへ反映します。同じページでrefreshしても
operatorが触った選択は維持されますが、name+portが列挙結果から消えた場合はplaceholderへ
戻してfail-closedにします。出荷・現行productionの既定adapterは `generic-json`
(flat frame、HELLO後の権威snapshot取得を必須とする順序制約付き)です。
`syndocal-envelope-v1`は旧KDMX v1 envelope wire向けの明示的なlegacy互換/
診断用選択肢です。未知名の黙ったfallbackはなく、adapter未選択時は既定の
`generic-json`が適用されます。

releaseMacroはphysical acceptance完了までdisabledです。Setup previewでも
`releaseMacro.enabled:false`を強制し、受入れ後にoperatorが別工程で明示的に有効化
するまでは、rampの定義が存在しても実演済みとは扱いません。

## HTTP診断actionの恒久的loopback限定 (2026-08-25)

`POST /api/dj-agent/actions/*` のHTTP診断エンドポイントは恒久的にloopback限定
です。判定は実際のTCP peerアドレスで行い、Host/Origin/X-Forwarded-*や設定では
peerを偽装できません。物理ペダルとglobal hotkeyはDJ PCローカルで動作し、FOH側
のShow Controlはトークン認証済みの `/dj-link` WebSocket経由だけが正規経路です。
旧env `DJ_AGENT_ALLOW_REMOTE_ACTIONS` とconfig-fileの `allowRemoteActions` は
非推奨であり、trueを設定しても権限は開かず、固定の（呼び出し値を含まない）
セキュリティ警告を1件出力します。この方針でLAN向けread-only GET APIや
rb-output自身のSocket.IOイベントが認証付きになることはありません。

## Heartbeat interval checkpoint (2026-08-25)

DJ Agent の Syndocal heartbeat は、注入可能な interval API が返す handle を
opaque value として保持する。`0`、`false`、空文字列、`undefined` を含む falsy
handle でも armed state と分離して管理し、reconnect、再 open、stop の各経路で
同じ handle をちょうど1回だけ `clearInterval` へ渡す。既定の Node timer 経路は
従来どおり global `setInterval` / `clearInterval` を使用する。

checkpoint は branch `beta-v1.1.2`、commit
`7cc2f522048f95f9753ba87f0d4fc5c5e3f5b73e` で
`origin/beta-v1.1.2` へ push 済み。Ox-alpha 実装後、別 Ox-alpha が独立に
`node --check` 2 files、focused 3/3、full `tests/smoke.test.js` 62/62、
`git diff --check` を再実行し、P0/P1/P2なし、first-party warning 0 と判定した。
commit では共有 `tests/smoke.test.js` の MIDI hunks を除外し、interval hunks
だけを部分 stage した。DJ PC、LAN、Rekordbox、pedal、Syndocal ACK の physical
acceptance は引き続き未検証であり、次はHTTP action hardeningとadapter authorityの
Oxレビューを閉じて次checkpointを作る。

## 2026-08-25 live DJ PC checkpoint（hardware acceptanceではない）

| surface | live fact |
| --- | --- |
| peer | 旧buildのpeerはSetup endpointが404 (`peer old build 404`) |
| local Agent / MIDI / pedal / hook | いずれもOK |
| Syndocal | 現在disabled。send-failed境界も観測済みで、接続成功とは扱わない |
| physical acceptance | **0/12**。ハードウェア受入れは未実施 |

上記live factはソフトウェアの疎通・状態観測であり、物理ペダル、Rekordbox MIDI
Learn、virtual MIDI driver、Stream Deck/Elgatoの受入れ完了を意味しません。MinHook pinと
`build-dist`経路の最終レビューもpendingであり、完了扱いにしません。

### 旧dist削除 checkpoint

同日の配布監査で、既存 `dist` は39 files / `220,529,137` logical bytesであり、
`build-identity.json`、`install-manifest.json`、`release-manifest.json`、
`rb-output-1.1.2.zip`、`DJLinkForPCDJ-setup.exe`をすべて欠く旧生成物と確定した。
exact `C:\Users\kouty\Desktop\rb-output\dist` がGit ignoredかつtracked file 0、
reparse point 0、実行中process reference 0であることを確認し、そのディレクトリだけを
恒久削除した。削除後pathは存在せず、観測したphysical free-space gainは
`220,618,752` bytesだった。ソース、`node_modules`、`.venv`、native source、Git
branch/commitは削除していない。

したがって現在は配布可能なartifactが存在しない。Windows x64 Ableton Link addon、
全test/warning gate、identity-bound clean build、ZIP/installer manifest、Ox reviewが
揃うまでDJ PCへ転送してはならず、旧artifactの存在をrelease evidenceとして引用しては
ならない。

このdocs-only checkpoint開始時点のrepository位置は、branch
`beta-v1.1.2`、HEAD `6b9368ede62b8f2c3a5610924a71da9f176c015b`、upstream
`origin/beta-v1.1.2`と同一です。既存の他ファイルのdirty/untracked状態は保持し、
このsupport laneではcommit/pushを行いません。

## 権威ソースとwire契約(2026-08更新)

KDMX/Syndocalの権威実装(`crates/protocol/src/lib.rs`の`DjLinkEnvelope`/
`DjLinkFlatFrame`/`DjLinkAck`、`crates/io/src/remote_ws.rs`の
`handle_dj_link_client`)を照合し、次の2つのwire契約が証明されています。
どちらも`/dj-link`パス専用のWebSocketで、認証は (1) HTTP Host/Origin検証と
(2) HELLO内トークンの定数時間比較の2面で行われます。Authorizationヘッダは
無視されます。

- `generic-json`(既定・現行production): フラットframe。HELLOのみ
  `{type,eventId,sequence,protocol:"generic-json",token,capabilities}`を
  持ち、それ以外はpayloadがルートに展開されます。ACKは8フィールド固定
  (`type,eventId,ok,message,outcome,sequence,code,stateGeneration`)です。
  snapshot順序は必須です: 接続後の権威snapshot取得より前に
  `DJ_TIMELINE_STATE_REQUEST`以降を送信するとSnapshotRequiredで拒否され
  ます。
- `syndocal-envelope-v1`(明示選択時のみのlegacy互換/診断): レガシーv1 envelope。全frameが
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
直後でも、Stage 1のF13/F14は既存のローカルRekordbox MIDI操作を継続します
（F15はStage 1では従来どおりinactiveです）。この間のネットワーク側effectは
pendingまたはfailedとして記録し、snapshot待ちを理由にローカル操作を止めません。
Stage 2のtimeline操作だけは接続済みかつ権威snapshot確定時までfail-closedです。

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
