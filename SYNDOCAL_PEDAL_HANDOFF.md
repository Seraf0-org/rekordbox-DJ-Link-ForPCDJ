# Syndocal / Pedal handoff contract

この文書は、Syndocal側と`rb-output`側を別担当で接続するための実装契約です。

## 2026-08-25 strict show-sync v2 clean break

出荷・現行・productionの唯一のadapterは`syndocal-envelope-v2`です。旧flat
`generic-json`と`syndocal-envelope-v1`は設定、Setup、build identity、runtimeから
退役し、指定されても明示的に拒否します。fallback、legacy shim、暗黙変換はありません。
全frameは`{v:2,type,agentId,sessionId,sequence,eventId,payload}`の7フィールド固定です。

このclean breakは、再生位置/BPMが欠落したACTIVE、ペダル意図から合成したloop、
任意の`running`によるペダル所有権移行を廃止します。ACTIVEはexact master deck、
playSessionId、exact track identity、positionAtSendSec、effectiveBpm、単調増加
positionRevision、1500ms以下のsampleAgeMsが揃うまで送信しません。同一sessionは
completeになった時点で一度だけACTIVEを出し、その後はTRACK_SYNCを連続送信します。
nonempty contentIdは権威であり、異なるcontentIdを同じtitle/artistで同一視しません。
物理LAN/MIDI/ペダル/Rekordbox/Syndocal ACKの受入れは別途必要で、mockから完了とは
主張しません。

## 2026-08-25 v1.1.3 pre-commit checkpoint

現在の作業位置はbranch `beta-v1.1.2`（配布versionとは独立した履歴上のbranch名）、
配布product version `1.1.3`です。`package.json`、root package-lock identity、
`installer.iss`、Setup UI/API、versioned Rekordbox mapping artifactはすべて`1.1.3`へ
同期しました。旧`1.1.2`名の配布artifactは作業ツリーに存在しません。

現時点の検証証拠は次のとおりです。

- strict v2 + smoke + Setup + provenance focused gate: 150/150 pass。
- version/Setup/provenance gate: 67/67 pass。
- package/provenance/strict v2 gate: 81 pass、0 fail、2 skip。skipは環境変数
  `RB_OUTPUT_PKG_SMOKE=1`を必要とするreal/adversary pkg exe smokeです。
- full `npm test`: 328 total、326 pass、0 fail、2 skip。skipは環境変数
  `RB_OUTPUT_PKG_SMOKE=1`を必要とするreal/adversary pkg exe smokeだけです。
  strict v2の14 testsとTRACK_SYNC 262,145-frame enduranceを含め全実行対象がpassしました。
- 変更対象JavaScript 18 filesの`node --check`は18/18 pass、first-party warningは0です。
- 独立Ox-alpha最終監査はP0/P1なしでPASSしました。tracked
  `binding.gyp.patched`がmanifest pinと不一致だった既存欠陥は、生成器のbyte-exact出力
  `b3dc833d8e80cb8e0cd36c3087f39f04dfa12e2b37f435931bbb5fec256e0cca`へ
  復元しました。この参照だけは上流由来の末尾空白と終端改行なしを含むため、狭い
  `.gitattributes`で`-text -whitespace`を指定し、`core.autocrlf`によるbyte改変を
  禁止しています。他のsourceのwhitespace検査は抑制しません。
- clean-break後に到達不能となった旧`control-id-conflicts-with-physical`分岐も削除し、
  legacy dead pathを残していません。

したがってsoftware source gateは閉じました。commit/pushと配布生成の後にも、
物理LAN、Rekordbox、MIDI、ペダル、Syndocal ACKの実機受入れも未検証です。

旧生成物inventoryではexact path `C:\Users\kouty\Desktop\rb-output\dist`に
32 files / `91,752,038` logical bytesが存在しました。内容は`content_lookup.exe`、
`inject_hook.exe`とPyInstaller `_build`だけで、`server.exe`、versioned ZIP、
installer、build/install/release manifestを欠く不完全な生成物でした。source checkpoint
push後に、Git ignored、tracked file 0、reparse point 0、process reference 0、二回の
安定サンプル、clean worktree、HEAD/upstream同一を再確認し、このexact directoryだけを
削除しました。`npm run build:dist`で再生成可能です。source、`node_modules`、`.venv`、
native source、Git履歴は削除していません。

同じclean/upstream checkpoint後に、ignoredかつuntrackedの
`native\bin\obj\{buffer,hde64,hook,hookdll,trampoline}.obj`もexact pathで削除しました。
5 files / `1,081,152` logical bytesで、`scripts\build-hook.ps1`から再生成可能です。
配布入力の`native\bin\rb_hook.dll`とMinHook source/cacheは保持しています。

### v1.1.3 strict-v2 pushed source checkpoint

上記source、version、mapping、byte-exact Ableton reference、tests、handoffを
`5eaf1994e1bf4456857fefd36cc0ce827145b603`としてcommitし、branch
`beta-v1.1.2`から`origin/beta-v1.1.2`へpushしました。push直後にlocal HEADと
remote-tracking HEADが同じfull hashであることを確認し、source worktreeはcleanです。
最終source gateは`node --check` 18/18、`git diff --check` pass、secret pattern
scan 0件、full `npm test` 328 total / 326 pass / 0 fail / 2 intentional skip、
first-party warning 0です。独立Ox-alpha最終監査はP0/P1なしでPASSしました。

このcheckpointはsource pushだけです。versioned ZIP/installerのidentity-bound clean
build、DJ PCへのinstall、物理LAN、Rekordbox、MIDI、ペダル、Syndocal ACK、切断・再接続、
両PC restartは未実施であり、hardware acceptance 0/12のままです。

## v1.1.3 first-run Setup契約 (2026-08-25)

DJ PCのSetup cardはDJ Agentがdisabled・未設定・native device未接続でも常時表示
されます。カードが読むのは `GET /api/dj-agent/setup` だけで、同APIはlocalhost専用
です。request peerのloopback、Hostのlocalhost/loopback、Originの空値または
localhost/loopbackをすべて満たす必要があり、Host/Origin/peerのいずれかが不成立なら
403で拒否します。LAN向けの通常status/read-only APIとSetup APIの公開境界は別です。

Setupはread-onlyであり、token input、token表示、localStorage保存、サーバー設定を
変更するPOSTを持ちません。config preview/download/copyもtoken-freeです。カードから
提供するversioned artifact
`CustomMIDI1-Syndocal-v1.1.3.csv` はoperatorがRekordboxのMIDI Learn/CustomMIDI1へ
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
戻してfail-closedにします。adapterは`syndocal-envelope-v2`だけを表示し、
未設定時もv2を使います。旧flat/v1名と未知名はblank/blockedになり、fallbackしません。

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
versioned ZIP、`DJLinkForPCDJ-setup.exe`をすべて欠く旧生成物と確定した。
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

peer側の権威wireは`syndocal-envelope-v2`のみです。`/dj-link`専用WebSocketで、
全frameは`{v:2,type,agentId,sessionId,sequence,eventId,payload}`の7フィールド固定、
frameは64KiB以下、文字列は1..256 UTF-8 bytesかつ制御文字なし、tokenは
32..256 bytesです。ACKは
`{v:2,type:"ACK",eventId,sequence,outcome,code,stateGeneration}`の7フィールド
固定です。`accepted`と`duplicate`だけを成功とし、missing/extra/nonfinite/stale/
future/unknown値は成功へ持ち上げません。

未ACKのphysical eventは再接続後も同じeventIdとsemantic payloadを保持します。
playSessionIdも不変です。connection sessionIdは新規発行し、wire sequenceは新しい
接続試行として単調増加させます。旧socketのACK、異なるsequence、reorder、duplicate
送信要求は適用しません。TRACK_SYNCは連続revisionで回復可能なためACK待ちをせず、
connection generation + wire sequenceから作る定数メモリのsession-local eventIdを使います。
durable physical eventId台帳を消費せず、再接続時にはreplayしません。新connectionでは
新しいTRACK_SYNCを待ち、旧socket/sessionはfenceします。ACTIVE/LOOP/RELEASE等の
physical eventはACK対象です。

## 接続と状態同期

WebSocket接続後、クライアントは順に`DJ_AGENT_HELLO`、`DJ_STATE_SYNC`、
`DJ_TIMELINE_STATE_REQUEST`を送信します。再接続・再起動後も同じ順序で、
Syndocalは現在の権威状態を`DJ_TIMELINE_STATE`で返してください。状態が返る
まではtimeline actionを送らず、`timeline-control`中の切断は`dj-control`へ
自動復帰しません（安全側に停止します）。

`DJ_TIMELINE_STATE`の形式は次です。

```json
{
  "v": 2,
  "type": "DJ_TIMELINE_STATE",
  "agentId": "syndocal",
  "sessionId": "syndocal-session",
  "sequence": 42,
  "eventId": "timeline-state-42",
  "payload": {
    "state": "running",
    "loopActive": false,
    "timelineId": "show-2026-08-21",
    "positionBars": 128,
    "playSessionId": "play-session-42",
    "pedalOwner": "dj",
    "releaseEventId": null
  }
}
```

payloadは上記7フィールド固定です。generic `running`だけではペダル所有権を
移しません。`pedalOwner:"timeline"`、現在のplaySessionId、同sessionの相関済み
DJ_RELEASE eventIdがすべて一致した時だけ`timeline-control`へ移ります。RELEASE後の
late TRACK_SYNC/LOOPはsession fenceで破棄し、所有権を再取得できません。
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
eventIdで冪等処理し、同じIDを二重適用しません。v2 ACKは次の7フィールド固定です。

```json
{
  "v": 2,
  "type": "ACK",
  "eventId": "...",
  "sequence": 42,
  "outcome": "accepted",
  "code": null,
  "stateGeneration": 7
}
```

`outcome`は`accepted`/`duplicate`/`no_mapping`/`rejected`/`busy`で、
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
