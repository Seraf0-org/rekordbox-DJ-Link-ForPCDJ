# Syndocal / Pedal handoff contract

この文書は、Syndocal側と`rb-output`側を別担当で接続するための実装契約です。

## 2026-08-30 current product source 1.1.12 / v1.1.11 production any-deck strict show-sync v3

現在の唯一のadapterは`syndocal-envelope-v3`で、全frameは
`{v:3,type,agentId,sessionId,sequence,eventId,payload}`のexact shapeです。
flat/v1/v2は退役し、設定・Setup・runtime・build identityで明示拒否します。
product source versionは`1.1.12`です。v1.1.12のinstaller、tag、public release、または
hardware acceptanceはこの文書で主張しません。production schema、external config、
CustomMIDI1 CSVは引き続きv1.1.11です。current/next operator routeはtracked
`config/dj-agent-v1.1.11.example.json`と
`server/public/setup/CustomMIDI1-Syndocal-v1.1.11.csv`を使います。exact
`start-all.bat --init-config`は存在しない場合だけ
`C:\SyndocalShow\dj-agent-v1.1.11.json`を作成し、deployed historical
`C:\SyndocalShow\dj-agent-v1.1.5.json`をread/copy/overwrite/deleteしません。

既存の厳密なv1.1.10外部JSONは、同じPowerShellで
`$env:DJ_AGENT_CONFIG_PATH`にその絶対パスを設定してから
`start-all.bat --upgrade-config`を一度だけ実行します。migrationは既知の
v1.1.10 schemaと32〜256-byte whitespace-free tokenだけを受理し、tokenを
v1.1.11 token-free templateへ移して、sourceを変更せず、targetを排他的に作成します。
作成後はcurrent strict preflightだけを実行し、次のPowerShell assignmentを表示して
runtimeを起動しません。全DJ PCの移行完了後に、このpredecessor pathを削除します。

## 2026-08-30 product source 1.1.12: `REKORDBOX LOCAL TEST / NO SYNDOCAL`

Implementation checkpointはbranch `beta-v1.1.2`、base/upstream
`a13d7bff59db5e7c00e19655f87c69db7cb52005`から作成したcommit
`2e1d04c`（`feat: add standalone Rekordbox pedal test mode`）です。次のactionは
このcheckpointをpushし、同一checkoutでfixed local configをinit/preflightしてから、
Rekordbox実再生中にF14 LoopHalfとF13 HPF→fade→Cue/Stop/resetを物理ペダルで受け入れることです。
Syndocal、Timeline、LAN、ACKはこのstandalone受入の対象外です。

これはSyndocal handoffを行わず、既存のHook/Rekordbox candidate、MIDI、pedal、routerを
DJ PC単体で確認するための明示的なtest-only modeです。productionのv1.1.11 schema/config/CSV
とは別の`rb-output-rekordbox-local-test-v1` discriminatorを使い、固定外部JSON
`C:\SyndocalShow\rb-output-rekordbox-local-test-v1.json`だけを読みます。
`DJ_AGENT_CONFIG_PATH`、token、NIC、Syndocal networkは使いません。server/UIは
`http://127.0.0.1:8787`のloopbackだけにbindし、status/action deliveryは
`not-applicable/local-only`として表示します。

管理者はcontrolled Windows DJ PCのcheckout rootで、次の順に一度だけ実行します。

```powershell
.\start-all.bat --init-rekordbox-local-test
.\start-all.bat --preflight-rekordbox-local-test
.\start-all.bat --rekordbox-local-test
```

`--init-rekordbox-local-test`は固定targetが存在しない場合だけ作成します。作成前に
MIDI outputをauto-enumerateし、名前がexactに`CustomMIDI1`であるentryが`0..4096`の整数portと
ともに**ちょうど1件**あることを要求し、その現在portをJSONへ保存します。portの推測、
複数件の選択、既存targetの上書きは行いません。targetにはcurrent userだけの
restrictive Windows ACLも必要です。`--preflight-rekordbox-local-test`は同じ
`CustomMIDI1`を再列挙し、保存済みname+portと唯一のcurrent entryの完全一致を確認します。
このpreflightはbuild、server、Rekordbox、Hook、MIDI send、pedal actionを開始しません。

`--rekordbox-local-test`はpreflight後にHookをrebuild/provenance-checkし、同じmodeのsource
serverだけをrestartし、supported RekordboxへHookをinjectしてloopback UIを開きます。
source-process fenceは全portとpre-listen状態を対象に、起動前、許可されたsame-mode停止後、
spawn直前、およびnew childがlistenerを所有した後からsuccess返却前まで再検査します。
Hook injectionは固定`--launch-settle-seconds 15`を使い、自動起動した今回の`Popen` PIDだけを
canonical executable path/name/create-timeで連続監視します。PIDの終了、path/name/create-time
変化、照会不能、wait deadline超過はreplacement scanを行わずfail-closedです。既存の対応版は
settleを待たずに注入します。
productionなど反対modeはPID/modeを表示してfail-closedとし、自動停止・置換しません。
予期しないsame-modeもfail-closedで、失敗時に終了するのは今回spawnしたchildだけです。
禁止されたenvironment overrideが1つでもある場合もfail-closedです。

local ownerは、currentでfreshかつactually playing、かつexactなadmitted deck、deckId、
playSessionId、frozen identityが揃った場合だけ成立します。selectorはNFC/case-sensitive
`titleContains`の`人生オーバー`です。不一致時はfresh/playing Deck 1だけが`1400 ms`
後のbounded fallback候補になります。stale、stopped、foreign、replacement、identity不足
はMIDIを動かしません。F14はlocal LoopHalf、F13はFilter HPF（CC16、64→127、1000ms）→
ChannelFader fade（CC17、127→0、1000ms）→Cue/Stop Note37 exactly onceの順で、Stop後に
HPF 64/Fader 127へresetします。F13は各phaseでfrozen local ownerを再検証し、途中で
replacement、stop、stale、foreign sessionになった場合は残りのfade/Stop/resetをcancelし、
旧session向け命令を新しい曲へ送信しません。Timeline/Stage 2および`DJ_TIMELINE_*`は
このmodeでは存在せず、F15を含むtimeline actionは送信しません。

このmodeのlocal actionにはSyndocal ACKがなく、deliveryは`not-applicable/local-only`です。
通常の引数なし`start-all.bat`は変更されず、productionではfresh candidateをadmitする前に
terminal `accepted`/`duplicate`の`DJ_TRACK_ACTIVE` ACKが必須です。production切断中に
local MIDIを継続できるのは、そのACKで既にadmit済みのownerだけで、freshなno-Syndocal
candidateをoffline pathからadmitすることはありません。

software checkpointでは`npm test`が**533 tests / 531 pass / 0 fail / 2 intentional
package-smoke skip**で完走し、local focusedは**40/40**、process fenceは**14/14**です。
first-party warningは**0**です。独立Terra xHighの最終安全監査はP0/P1なしのGOでした。
このmodeのphysical acceptanceは未主張です。残る証跡は、controlled DJ PCでの唯一の
`CustomMIDI1`列挙とport、Rekordbox Learn/実出力（LoopHalf、HPF、ChannelFader、Cue/Stop）、
Hookの`人生オーバー`一致とDeck 1 `1400 ms` fallback、F14 measured-loop response、F13の
timing/order/reset、stale/foreign ownerのblock、loopback statusの
`not-applicable/local-only`表示、および通常productionのterminal ACK・切断/再接続です。

checkpoint時のworkspace inventoryでは、ignored `C:\Users\kouty\Desktop\rb-output\dist`
に2026-08-25生成の旧v1.1.3 artifactが**277,382,202 bytes（264.53 MiB）**残っています。
現行checkoutには、このexact target setを対象にしたtracked cleanup harnessのfocused safety
testと独立adversarial reviewが揃っていないため、本checkpointでは削除していません。
この旧artifact cleanupはblocked remaining workとして保持し、現在のlocal-test sourceや
実機受入証跡として扱いません。

同PCの最初のfull-runtime local launchは、bare `npm run build:hook`が実際の
`C:\TDM-GCC-64\bin\g++.exe`をtrusted compiler root外として拒否し、server/injection前に
fail-closedしました。local-test branchだけが固定literal
`-AdditionalTrustedCompilerRoots C:\TDM-GCC-64`を渡すようにし、production/no-argument branchは
bare buildのまま維持しました。caller env/config/追加launcher argumentからrootを選べません。
既存build-hookはabsolute/non-drive/non-reparse directory、first resolved native compiler、
compiler/source/MinHook/output evidenceを引き続き再検証します。独立Terra xHigh再監査は
P0/P1なしのGO、focused launcher/provenance/timingは**14/14**、first-party warningは**0**です。

compiler-root修正後のcontrolled local launchではcompiler
`C:\TDM-GCC-64\bin\g++.exe`（SHA-256
`8CFA5EA1C1D29BE31078CB92CD0CAC635B90183D17460C361CC90645B77D11FB`）を検証し、AMD64
`native\bin\rb_hook.dll`（SHA-256
`D066B2D3E233F0485B0F7B71E0C0E7D4514452AE1525B99249661182DA55F055D`）を生成しました。
local source PID `55684`はport 8787を所有しました。旧immediate auto-injectはRekordbox
7.2.18 PID `72800`からHook helloを受けた後に同PIDが終了したため、stable runtime証跡には
採用しません。Rekordboxを通常起動して15秒後に同じHookをinjectしたPID `49440`は継続し、
Hook helloとopened-handle path/create-timeのread-only実検証が通過しました。token-free statusは
`enabled:true`、`localTestMode:true`、`testOnly:true`、
`deliveryPolicy:not-applicable/local-only`、MIDI `CustomMIDI1` port 2 connected、pedal
`listening`を返しました。これは起動証跡であり、F13/F14の物理ペダル受入はまだ未確認です。

この観測を受け、自動起動だけはexact `Popen` PID/path/name/create-timeを固定15秒連続監視し、
opened Windows process handleでもimage path/creation FILETIMEをremote write前に再検証するよう
修正しました。exit、identity変化、照会不能、deadline超過はreplacement scanなしで
fail-closedです。既存running Rekordboxはsettleなしの従来経路を維持します。Python focused
**19/19**、injector/launcher/smoke **73/73**、first-party warning **0**、独立Terra xHigh
adversarial reviewはP0/P1なしのGOです。現在のstable PID `49440`を保護するため、修正後の
fresh auto-launchはまだ再実行しておらず、次回cold launch acceptanceとして明示的に残します。

Windows target security is bounded by the NTFS ACL inherited from the exact
`C:\SyndocalShow` parent; the updater does not claim Unix mode bits as a Windows
ACL. Its pinned PowerShell writer uses `FileMode.CreateNew` plus `FileShare.None`
through flush and rejects a reparse-point parent. The Node parent path/identity
evidence is passed into the helper; its `OPEN_REPARSE_POINT` parent handle's
own reparse attribute and File ID must exactly match before token write. Parent
ACL ownership and inheritance remain operator-managed and the updater never
mutates them. Broad Allow-write access for Everyone, Authenticated Users, or
BUILTIN\\Users fails before target creation as fixed reason
`PARENT_ACL_UNSAFE`. The parent handle permits read/write sharing but omits
delete sharing; the target remains `FileShare.None` through durable flush.

### 2026-08-28 v1.1.11 upgrade-writer live failure repair checkpoint

Branch `beta-v1.1.2` was clean and equal to upstream at base HEAD
`eea9d1dcaf82542eb4dc179724df049af9f02f1d`. On the controlled DJ PC, the
initial updater rejected the inherited `Authenticated Users: Modify` parent
ACL before creating a target. After the operator explicitly narrowed the exact
parent to the current user, LocalSystem, and Administrators, the original
writer still failed at its parent-directory native handle with Win32 code 203;
a direct non-secret `FileStream(CreateNew, FileShare.None)` probe succeeded.
The repaired writer therefore binds the parent with `FILE_READ_ATTRIBUTES` and
`FILE_SHARE_READ | FILE_SHARE_WRITE`, while still omitting
`FILE_SHARE_DELETE`. It also requires an allowlisted fixed `OK` marker and
reports only fixed failure reasons; helper stderr, config bytes, and token bytes
remain undisclosed. Automatic ACL mutation was prototyped, rejected by
independent review because inherited/Deny ACE semantics were under-proven, and
removed completely.

Supervisor and independent Terra xHigh gates passed: `node --check
scripts/upgrade-show-config.js`, `node --test
tests/upgrade-show-config.test.js` (**18/18**, including live Windows
rename/replacement and cleanup fences), and scoped `git diff --check` with only
the repository's LF-to-CRLF notices. First-party warnings are **0**. The new
target still did not exist at this checkpoint, so DJ-PC rerun, generated target
validation, strict preflight, runtime restart, Rekordbox state coherence,
pedal, Syndocal ACK, LAN, and physical hardware acceptance remain unverified.
The first next action is pull this checkpoint on the DJ PC and rerun the same
`start-all.bat --upgrade-config` against the unchanged v1.1.10 source.

branch `beta-v1.1.2`の再接続ABA fenceはcommit
`eb9d131f7b57c29231bdf605f498c877180ad553`としてpush済みです。この次の
controlled-source checkpointは、missed track-load時のidentityless再生sessionに対し、
一意なDB signature resultを同一deck/session/startedAt、fresh revision/observedAt、
BPM、duration、proof generationがすべて一致する場合だけ採用します。generic/preload、
stale/equal-conflicting sample、停止・別session・別deck・曖昧lookupは引き続き
fail-closedです。equal-revision duration競合を含むsmokeは**63/63**、変更4 JSの
`node --check`と`git diff --check`はpassし、独立Terra xHigh adversarial reviewも
GOです。full `npm test`、対象DJ PCへの再配備、実DB lookup、real Syndocal ACK、
physical hardware acceptanceは未確認です。first-party warningは**0**です。

### 2026-08-27 live Stage 1 observation (partial hardware evidence)

DJ PCのcontrolled source restart後、Rekordbox Deck 1で`Demo Track 2` / `Loopmasters`
を実再生した。Agentは`ownerDeck=1`、`ownerDeckId=rekordbox-deck-1`、新しい
`playSessionId=75539d72-4463-4a60-a405-971a744db720`をadmitし、Syndocalは
Timeline 1を`running`、loop `false`として開始した。wire identityは既存exact
title+artistであり、internal trackは`contentId=235403562`へenrichされた。このため
この観測は新しいsignature-identity proof経路そのものの実機受入ではない。

同じsessionでF13を1回押した結果、`DJ_RELEASE`
`93b117d8-4e4a-4431-9100-271487f6e875`は1 attemptで送信され、22 ms後に
`outcome=accepted`、`stateGeneration=2`を受信した。ローカルMIDIはFilter CC16
64→127/1000 ms、ChannelFader CC17 127→0/1000 ms、Cue/Stop Note37を完了し、
Filter 64/Fader 127へresetした。Agentは`timeline-control`、release phase
`complete`へ移り、Timelineは`running`、loop `false`を維持した。これはStage 1の
track admit→Release handoffの部分実機証跡であり、全12項目、reconnect/restart、
Stage 2、signature proof、installer/identity-bound artifactのacceptanceは閉じない。
runtimeの`/api/status`はversion `1.1.8`、generatedAt
`2026-08-27T07:46:25.894Z`、`provenance.status=dev-unverified`、`gitCommit=null`
だったため、この観測を特定commitへcryptographically bindしない。

同じlive sessionでDeck 1/2の表示を連続採取したところ、Hookのtitle/artist付き
metadataが約300 msごとに`db-signature-refresh`のnull identityへ交互に消え、Deck 2
の曲名が点滅した。原因は`durationSec=null`を`Number(null)=0`として正のdeck尺と
矛盾扱いしたことと、Content ID cache hit時に欠損metadataの再適用をskipしたこと。
source fixはmetadata整合判定とhydration eligibilityを小さいpure helperへ分割し、
null/欠損値を比較対象外、正のduration/BPM矛盾を引き続きreject、cacheを同じ
Content IDにだけ再適用する。直接Content ID lookup失敗後のsignature fallbackも、
resolved Content IDがcaptured/current IDと完全一致しない限りmerge/adoptしない。
focused helper + smokeは**67/67** pass。これはsource-onlyであり、対象DJ PCへ
再配備して点滅停止・waveform復帰を観測するまでhardware fixを主張しない。Deck 2の
大きなseek戻りは採取時に実測loopがONで、そのloop範囲のwrap自体は正常だった。

v1.1.7 any-deck境界はhistorical/supersededなレビュー済み境界です。product source
1.1.12のcontrolled-source changeはその旧境界を基礎にした現在のtrancheで、production
schema/config/CSVはv1.1.11のままです。本書はinstaller、tag、public release、対象DJ PCへの配備、または
physical HW-4 12項目の受入を主張しません。

exact mappingに一致した**任意の実再生Rekordbox deck**がshow-control candidateです。
`DJ_TRACK_ACTIVE`はdeck/deckId/playSessionIdごとに一度だけ、`contentId`またはexact
title+artistの一方だけを持って送ります。`DJ_TRACK_SYNC`はそのexact ownerとidentityの
positionRevisionだけを進めます。MASTER/master-changeは診断だけで、ownerを付与・置換・
再triggerしません。unmapped/foreign/stale/conflicting/ambiguous candidateはownerを変更せず
fail-closedです。sessionの最初のACTIVEがone-of wire identityをfreezeし、late contentId等の
metadata enrichmentはdiagnostic/internal stateだけを更新して後続ACTIVE/SYNCのidentityを
切替えません。generic `DJ_STATE_SYNC`は`{released}`、または
`{released,ownerDeck,ownerDeckId,activePlaySessionId}`のall-or-noneだけです。
`DJ_LOOP_STATE`と`DJ_LOOP_FALLBACK`も同じadmitted deck/deckId/playSessionIdへ相関し、
outer payloadのunknown/legacy key（`masterDeckRevision`を含む）はrejectします。

F14の物理意図はRekordbox MIDI送信より先にresponse windowを開始します。freshな
同一admitted owner sessionの測定が権威で、actual no-responseだけが別型の
`DJ_LOOP_FALLBACK`を送ります。
profileは`8 → 4 → 2 → 1 → 1/2 → 1/4 → 1/8 → 1/16 → 1/32 → 1/64`で、2では
止まりません。不正・stale・矛盾応答はfallbackをfail-closedで抑止し、late fresh測定は
predictionを上書き・rebaseします。F13 Releaseは、owner-deck HPF開始と同じ初期edgeで
相関済み`DJ_RELEASE`を一度だけSyndocalへ送ります。これはfade/Stop/resetなど
ローカルMIDI結果から独立しています。初期edge後のローカル順序はHPF
（CC16 64→127/1000ms）→ ChannelFader（CC17 127→0/1000ms）→ Cue/Stop Note37で、
Stop後にFilter 64とFader 127へresetします。
fallbackは単調増加する`pedalIntentId`と、発行時点の
`baseMeasuredLoopRevision`/`baseLoopDivision`を必須で持ちます。実測wireは
`payload.loop`へ正規にネストし、旧flat shapeは受信側でfail-closedです。

focused software gateは通過していますが、DJ controller、Rekordbox MIDI、物理pedal、
wired LAN、real token/ACK、reconnect/restartは未受入で、matrixは**0/12**のままです。

### 2026-08-27 CURRENT production title-owner selection checkpoint

公演用owner選定はexternal show JSONのexact
`trackActivity.ownerSelection = {"mode":"titleContains","titleNeedle":"人生オーバー","deck1MetadataWaitMs":1400}`
だけを受理します。selectorはNFC正規化後のcase-sensitive title包含であり、artistや
MASTER状態を選定条件にしません。ただしstrict-v3 text identityはtitleとartistの両方を
要求するため、該当titleでartist未着のdeckは送信せず待機します。最初に送ったone-of
identityはそのplay session中固定し、後着contentIdで切り替えません。

実再生かつfreshなpositiveが1つならそのdeck、複数ならfresh/playing Deck 1を優先し、
Deck 1がtransport-validでない場合だけ最小番号のtransport-valid positiveを選びます。
positiveが0の場合はfresh/playing Deck 1だけを1400 ms後にfallback候補とします。
1400 msはstrict-v3の1500 ms freshness上限に対する100 ms reserveで、遅延callbackが
1500 msを超えた場合は送信しません。Deck 2だけの観測はDeck 1 fallbackを作りません。
router stop/start後はdeckごとの新generation track+playback snapshotが揃うまで旧deckを
再告知せず、再接続の`requestCurrent`はfreshな選定済みownerと凍結identityだけを
`DJ_TRACK_ACTIVE`として再告知します。

branch `beta-v1.1.2`、base HEAD/upstream
`8dc1808e8addd7d08b9d41bf0e5941ea2f896918`からのtitle-owner trancheとして、
focused関連**168/168**、full `npm test` **449 total / 447 pass / 0 fail /
2 intentional skip**、変更JS `node --check` **6/6**、README contract **6/6**、
`git diff --check`がpassし、first-party warningは**0**です。独立Terra xHigh reviewは
restart時のper-deck provenance、timer generation、reconnect再告知、strict config/UI/
launcher/READMEを再監査してP0/P1/P2なしの**GO**でした。これはsource checkpointであり、
対象DJ PCへのpull/config更新、real Rekordbox title、wired ACK、pedalまたはHW-4受入を
主張しません。Stage 2 trancheでは`transitionHoldActive`をstrict-v3の診断値として受信し、
F13をcurrent `loopActive`の反対を送るabsolute LOOP_SETへ、F14をactive-loop-only
LOOP_HALFへ固定します。

### 2026-08-28 CURRENT content-identity transition checkpoint

ライブ確認でDemo Track 2をロードした際、新しい`contentId=235403562`が届いたのに、
直前の`More One Night × 動く、動く (Agate Trance&Makina bootleg)`のtitleが残った。
これは曲のadmit条件ではなく、track identity replacement時の古いdeck/global
now-playing metadataのmerge漏れだった。current sourceは`track_load`と有効なOLVC
content-ID ingress（`@TrackBrowserID`/`@ContentID`）で、異なる非空IDへの遷移を検出すると
新しいsnapshotを公開する前にtrack-bound metadataを消去する。同一ID replayとnull→ID
enrichmentは保持し、owner selectionが古いtitleから再admitすることはない。

新しいfocused `node --test tests/track-identity-transition.test.js` は**5/5 pass**、
最終`npm test`は**470 total / 468 pass / 0 fail / 2 skip**。
この節はsource/test checkpointだけを記録し、DJ PCはまだpull/restart/reverify
していない。mapped track、Rekordbox MIDI、physical pedal、wired LAN、real ACK、
installer/tag/public releaseは未確認・未主張です。

### 2026-08-28 CURRENT watchdog and Stage 2 pedal contract checkpoint

The source-only v1.1.11 tranche is a dirty worktree based on HEAD `4e26da2`;
it remains intentionally uncommitted and unpushed; base HEAD equals its upstream
tracking ref. Release ramp
configuration remains exactly 1000 ms with a 50 ms update interval; the
watchdog is now scheduled only after the nominal duration plus one update
interval, so an adapter endpoint callback at the nominal boundary remains
authoritative. A truly missing callback still records the specific incomplete
ramp failure and continues the single Stop/reset tail. Deterministic boundary
and missing-callback tests cover both Filter and ChannelFader ramps.

Stage 2 F13 is the absolute current-loop `DJ_TIMELINE_LOOP_SET` toggle. F14 is
the separate active-loop-only `DJ_TIMELINE_LOOP_HALF` v3 command with exact
`timelineId` and `playSessionId`; its ACK, terminal failure, reconnect, and
pending latch are independent from F13, and it never emits Rekordbox MIDI.
The retired F14 toggle path and policy module/tests are removed. A rejected
Stage 2 command carrying `timeline_not_playing` now marks the snapshot gate
not-ready and requests a fresh authoritative state without inventing idle or
automatically changing mode. The local confirmation-only `Return to DJ
control` route remains loopback-fenced and can adopt only a fresh, playing
Deck 1 fallback; it does not mutate Timeline or revive a released remote
owner.

Focused owner/auth tests pass **21/21** and **17/17**; the v1.1.10 → v1.1.11
one-way migration/security suite passes **15/15**. The complete full `npm test`
has not been rerun after this dirty extension, so no current full-suite pass is
claimed. All changed JS files pass `node --check`; `git diff --check` exits 0.
First-party warning count is **0**
(Git's LF-to-CRLF working-copy notices are not source warnings).
No restart, deployment, installer/tag/public-release, peer ACK, or physical
hardware acceptance is claimed. The next safe action is independent review
and integration verification against the peer's v3 capability-10 contract;
keep the working tree uncommitted until the supervising release checkpoint
authorizes its handoff.

### 2026-08-28 CURRENT live-state coherence and broadcast checkpoint

The 2026-08-28 v1.1.11 production source-only live-state fix is based on branch
`beta-v1.1.2`, pre-commit HEAD/upstream
`4e26da201fef2ff204c28c7041b368e7283faebe`. The previous runtime could make
Pause/Play flicker, make an active loop alternate between ACTIVE and SET, and
reported the measured 2-beat loop `106782..107610 ms @ 145 BPM` as
`116.03125` beats. Its state stream also emitted approximately **4,000 state
events / 3 s** and **74 MB**.

The new source path gives explicit playback edges precedence over inferred
position state, builds each deck once per snapshot, preserves a partial ACTIVE
update only when its non-empty track identity exactly matches, and projects a
measured loop as duration-only **2 beats** when absolute beat zero is unknown.
It does not invent absolute endpoints. SSE/state publication is bounded by a
50 ms latest-wins coalescer. Focused verification is **79/79 pass** and an
independent Terra xHigh review is **GO**.

This remains a source/test checkpoint. The DJ PC pull and agent restart, plus
physical remeasurement of stable Pause/Play, ACTIVE/SET, and 2-beat display,
are still unverified; no deployment or hardware acceptance is claimed. The
full `npm test` is now **502 tests / 500 pass / 0 fail / 2 skipped** in
`297277.8748 ms`. This is source/test evidence only; the DJ-PC pull/restart
and physical remeasurement remain unverified.

### DEPLOYED HISTORICAL / DO NOT EXECUTE — v1.1.5 controlled-source handoff

以下はv1.1.5のdeployed controlled-source handoffと当時のsoftware/hardware evidenceです。
provenanceのため保持しますが、current/next operator guidance、v1.1.11 config/CSV、または
any-deck authorityとして実行・再利用・解釈してはいけません。

このcheckpointはtracked token-free template
`config/dj-agent-v1.1.5.example.json`と、checkout位置に依存しないexact
`start-all.bat --init-config`を追加しました。initializerは
`C:\SyndocalShow\dj-agent-v1.1.5.json`を存在しない場合だけ排他的に作成し、既存のvalid、
invalid、link targetを上書きしません。tokenを生成・読込・表示せず、build、server、
Rekordbox、injectを起動しません。このsoftware setup proofはreal token、HELLO、ACK、
MIDI、pedal、hardware acceptanceを一行も閉じず、matrixは引き続き**0/12**です。

このruntime checkpointではfull `npm test`が393 total / 391 pass / 0 fail /
2 intentional pkg skip、config initializer + launcher + security focusedが46/46、
Stage1+strict-v3 focusedが33/33、first-party warningは0です。
独立Terra xHigh再監査はrapid-F14/inactive-loop競合、
late fallback causality、実測loop wire shapeのP1を段階的に検出し、全修正後は
P0/P1/P2なしでPASSしました。Ox-alphaはこのsessionでcallableではなかったため、
Sol監督がこの限定例外とTerra独立再監査を記録しています。

## SUPERSEDED / HISTORICAL — 2026-08-25 strict show-sync v2 clean break

この節は過去のv2設計記録であり、**実行・設定コピー禁止**です。2026-08-25時点では
`syndocal-envelope-v2`を唯一のadapterとしていました。旧flat `generic-json`と
`syndocal-envelope-v1`は当時の設定、Setup、build identity、runtimeから退役させ、
指定時に拒否していました。全frameは当時
`{v:2,type,agentId,sessionId,sequence,eventId,payload}`の7フィールド固定でした。
現行production authorityは本書冒頭のproduct source 1.1.12 / v1.1.11 any-deck/v3だけです。

この過去のclean breakは、再生位置/BPMが欠落したACTIVE、ペダル意図から合成したloop、
任意の`running`によるペダル所有権移行を廃止していました。ACTIVEはexact master deck、
playSessionId、exact track identity、positionAtSendSec、effectiveBpm、単調増加
positionRevision、1500ms以下のsampleAgeMsが揃うまで送信しませんでした。同一sessionは
completeになった時点で一度だけACTIVEを出し、その後はTRACK_SYNCを連続送信していました。
この記録から現行の物理LAN/MIDI/ペダル/Rekordbox/Syndocal ACK受入れを主張してはいけません。

## SUPERSEDED / HISTORICAL — 2026-08-30 v1.1.4 source operation

This is archived v1.1.4 evidence, not a launch or configuration procedure. The
then-current show path was the target DJ PC's controlled source-acceptance
exception. H **(historical v1.1.4)** was the exact full commit
`c6ebb0fd917a82574b9ef61f12ebb41283db357e` on branch `beta-v1.1.2`, product
source version `1.1.4`; it did not claim that the present DJ-PC branch tip was
clean or upstream-equal, and a docs-only commit touching exactly
`README.md`/`SYNDOCAL_PEDAL_HANDOFF.md`/`API.md` may legitimately sit above H.
Its archived proof conditions and launcher notes are retired and must not be run
or copied. The immutable `v1.1.3` tag, installer, and all v1.1.4 guidance remain
historical evidence only. Current authority exists only at the beginning of this
document; this historical section contains no executable v2 adapter/configuration
instruction or current operator link.

## SUPERSEDED / HISTORICAL — 2026-08-25 corrective release preparation: v1.1.4

この節は過去のrelease preparation記録であり、**実行・設定コピー禁止**です。公開済み
`v1.1.3`はwire mismatchを含むimmutable historical artifactとして保持し、tagや
assetを移動・差し替えませんでした。当時の次のcorrective product versionは`1.1.4`でした。`package.json`、
root `package-lock.json` identity、`installer.iss`、Setup HTTP/UIのversioned mapping URL、
serverのstatic mapping filename、`CustomMIDI1-Syndocal-v1.1.4.csv`、packaging focused
fixtureはそのversionだけを参照していました。ここに記録されたadapter、JSON、artifact、
runtime event contractを現行環境へ設定してはいけません。

検証済みv1.1.4 installer公開後の起動案は、スタートメニュー／デスクトップの
`DJLinkForPCDJ` shortcutとインストール先`start-rb.bat`のpayload検証を想定していました。
これは現行受入れの手順ではありません。

当時の未公開v1.1.4 source-acceptance案にはcheckout外JSON、NIC、one-time token、
`syndocal-envelope-v2`、`CustomMIDI1`の照合が含まれていました。この旧設定を現在の
DJ PCへ適用してはいけません。現行のlauncher/設定は本書冒頭のproduct source 1.1.12 / v1.1.11 any-deck/v3 authorityと、
READMEの独立したcurrent source acceptance節だけに従います。

release tagはrepository ruleset `21434391`（`Immutable release tags v*`）で
`refs/tags/v*`の削除とnon-fast-forward更新を禁止します。workflowも
`GITHUB_REF_PROTECTED=true`、local/remote annotated tag dereference、`GITHUB_SHA`一致を
再検証し、条件を満たさなければassetを公開しません。

version sync source gateは`npm pkg get version`、root lock identityの二箇所、HEADとの差分に
対するnon-root package-lock entry不変性、Setup HTTP / mapping artifact / packaging focused
tests 19/19、対象source/testの`node --check`で確認済みです。`v1.1.3`の残存はこの文書と
READMEのimmutable historical evidenceだけであり、current product source、Setup URL、mapping
artifactには残っていません。

2026-08-26のcertified runtime-source H **(historical v1.1.4)** はbranch
`beta-v1.1.2`、product source version `1.1.4`の
`c6ebb0fd917a82574b9ef61f12ebb41283db357e`でした。ここに残るbranch/proofの説明は
履歴証拠であり、現行のproof commandまたは運用手順ではありません。未対応Rekordboxへの暗黙注入と退役済み
`REKORDBOX_EXE_PATH`経路をfail-closeした`ab643e6`、追随テスト修正`5110b2c`／`590115a`、
公演用source runbook`f3da76f`、およびその直前のregression gate checkpoint
`600ec0fd46729ed6c7bf5501ad70da8350141ec7`（履歴: full `npm test` 368 total /
366 pass / 0 fail / 2 skip / 371652.9948ms）は、いずれも履歴として
`origin/beta-v1.1.2`に存在します。

H **(historical v1.1.4)** の最終gateは次のとおりでした。focused smoke+envelope 89/89、launcher/config
focused 12/12、full `npm test` 377 total / 375 pass / 0 fail / 2 intentional pkg skip、
所要379134.5901ms、独立OxレビューAPPROVE。skipは`RB_OUTPUT_PKG_SMOKE=1`を必要とする
real/adversary pkg exe smokeだけでした。これらはsource regression gateの履歴であり、v1.1.4 tag、
identity-bound build、installer、`dist`、GitHub Release、DJ-PC実機、Rekordbox、LAN、MIDI、
Pedal、Syndocal ACKの完了を主張しません。

## SUPERSEDED / HISTORICAL — 2026-08-25 v1.1.3 pre-commit checkpoint

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

したがってsoftware source gateは閉じました。source commit/push、annotated release tag、
identity-bound配布生成も完了しましたが、物理LAN、Rekordbox、MIDI、ペダル、
Syndocal ACKの実機受入れは未検証です。

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

### SUPERSEDED / HISTORICAL — v1.1.3 strict-v2 pushed source checkpoint

上記source、version、mapping、byte-exact Ableton reference、tests、handoffを
`5eaf1994e1bf4456857fefd36cc0ce827145b603`としてcommitし、branch
`beta-v1.1.2`から`origin/beta-v1.1.2`へpushしました。push直後にlocal HEADと
remote-tracking HEADが同じfull hashであることを確認し、source worktreeはcleanです。
最終source gateは`node --check` 18/18、`git diff --check` pass、secret pattern
scan 0件、full `npm test` 328 total / 326 pass / 0 fail / 2 intentional skip、
first-party warning 0です。独立Ox-alpha最終監査はP0/P1なしでPASSしました。

### SUPERSEDED / HISTORICAL — v1.1.3 immutable tag and distribution checkpoint

operatorの明示承認後、annotated tag `v1.1.3`をsource/docs/cleanup HEAD
`24d38f6decbc8880149df1902ef8d2ccfe76b784`へ作成してGitHubへpushしました。remote tag
objectは`280b615a7928c2dc882ad8d901cddc575cf88a43`、peeled commitは上記full hashです。
tagは移動せずimmutableとして扱います。

tagged checkoutで
`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/build-dist.ps1`
を実行し、Step 0/7のclean tree、annotated tag、version triple、package-lock、Ableton-Link
x64 PE32+、pinned toolchainをすべて通過しました。Inno Setup 6.7.3は実行直前にも
SHA-256、Authenticode signer、versionを再検証し、次の配布物を生成しました。

- `dist/DJLinkForPCDJ-setup.exe`: `56,071,355` bytes、SHA-256
  `db86731814d934f396c91da043f476ebc1456a76c0b53172a0255d44c84a18ce`
- `dist/rb-output-1.1.3.zip`: `62,599,518` bytes、SHA-256
  `089509c8f4dee18fbe3901d62d7121692676f70afe88b8d635142110ec88d272`
- release identity hash:
  `ab67c6f189f8f535f3b7a3b1142420ff6ac1376f6d9bff16d9884f4cc7b5a226`

GitHub Release `v1.1.3`も公開済みです:
`https://github.com/Seraf0-org/rekordbox-DJ-Link-ForPCDJ/releases/tag/v1.1.3`。
installer、ZIP、`release-manifest.json`の3 assetsはすべてupload済みで、GitHubが記録した
size/digestは上記ローカル実測値と完全一致します。draft/prereleaseではありません。

`node scripts/verify-install.js --install-dir dist`とpackaged
`dist/server.exe --verify-install`はpayload 10件とembedded provenanceを検証してPASSしました。
ZIPは隔離したexact temp pathへ展開し、同じ二つの検証を再度PASSしました。ZIPは11 entries、
重複entry 0、absolute/traversal entry 0です。検証用temp treeはexact path/reparse確認後に削除
しました。

このPCのuser-level npm設定は`script-shell=C:\Program Files\git\bin\bash.exe`です。
当初はその経路がPowerShell 7優先の`PSModulePath`をWindows PowerShell 5.1へ持ち込み、
`Get-FileHash`未解決でfail-closeしました。post-release branchでは`build:dist`のlauncherを
exact `powershell.exe -NoProfile -NonInteractive`へ固定し、script自身もPSEdition Desktop、
`$PSHOME\Modules`、`Get-FileHash` / `Get-AuthenticodeSignature` / `Compress-Archive`の
exact module sourceとcommand typeを実作業前に検証します。caller由来のmodule path、
PowerShell Core、alias、duplicate resolutionへfallbackしません。

再発防止は`inno-setup-packaging`とPS5.1 probeの11/11 pass、full `npm test`の
328 total / 326 pass / 0 fail / 2 intentional real-package skip、変更testの`node --check`、
package JSON parse、実際のGit Bash設定下での
`npm run build:dist -- -ValidateAbletonLinkOnly` PASS、`git diff --check`で検証しました。
これはbuild launcherのpost-release保守修正であり、公開済み`v1.1.3` tag/artifactのruntime
payloadやidentityを変更しません。immutable tagは移動せず、公開assetも再生成・差し替え
していません。

### post-v1.1.3 packaging host boundary consistency tranche

`build:hook`も`build:dist`と同じexact
`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass`で起動し、二つのscriptは
`scripts/initialize-windows-desktop-powershell.ps1`だけをdot-sourceします。このhelperが
Windows PowerShell Desktopを必須とし、`PSModulePath`をexact `$PSHOME\Modules`へ正規化した後、
`Get-FileHash` / `Get-AuthenticodeSignature` / `Compress-Archive`を唯一のinbox module sourceと
command typeで解決できる場合だけ続行します。PowerShell Core、caller由来module path、alias、
duplicate command、互換fallbackは明示的に拒否します。これは公開済み`v1.1.3`には含まれない
post-v1.1.3 source maintenanceであり、`v1.1.3` tag、公開asset、product version、`dist`を
変更しません。次のversion/tag/release統合はこのtrancheの所有者ではなくrelease supervisorが
別途行います。

このtrancheのfocused source gateは`inno-setup-packaging`と`build-dist-ps51-probe`の
12/12 pass、`minhook-pin`の新しいshared-boundary named gate 1/1 pass、対象testの
`node --check`、PowerShell 5.1 parse、package JSON parse、`git diff --check`です。Git Bash
設定下の`npm run build:dist -- -ValidateAbletonLinkOnly`はPASSしました。実
`npm run build:hook`はshared bootstrapとMinHook offline pinを通過し、引数なしでは既存の
trusted compiler root gateが`C:\TDM-GCC-64\bin\g++.exe`を拒否します。既存の明示的
`-AdditionalTrustedCompilerRoots C:\TDM-GCC-64`ではそのprovenance gateを通過しますが、
現行`native\hookdll\hookdll.cpp:2235`の`GetTickCount64`が当該g++で未宣言としてcompile
失敗します。これはhost-boundary変更ではない次版native build blockerであり、このtrancheは
native sourceを修正しません。失敗実行は新しい配布物を生成せず、既存のignored
`native\bin\rb_hook.dll` SHA-256
`A73A0E65CD808E920B5C9C6DF39F8B24734D23D935A767DC98B76FFC294F57DD`は不変でした。
`minhook-pin`全体は既存native fixtureが未収束で8分以上出力なしとなったため、私が起動した
test processだけを終了し、全体passの根拠にはしていません。focused gateにfirst-party warningは
0件です。

配布物までは完成しています。残るDJ-Link完成条件はDJ PCへのinstall、物理LAN、Rekordbox、
MIDI、ペダル、Syndocal ACK、切断・再接続、両PC restartのhardware acceptance 12項目です。
現時点は0/12であり、配布生成PASSを実機完成へ読み替えません。

## SUPERSEDED / DO NOT EXECUTE — v1.1.3 first-run Setup契約 (2026-08-25)

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
`Cue=9025/9125`、`LoopHalf=9024/9124`です。

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

## SUPERSEDED / HISTORICAL — 2026-08-25 live DJ PC checkpoint（hardware acceptanceではない）

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

## SUPERSEDED / HISTORICAL — strict-v2 wire契約(2026-08-25; 次のCURRENT見出し直前まで)

この見出しから次のCURRENT見出し直前までのstrict-v2 runbookは過去の設計証拠であり、
**実行・設定コピー禁止**です。現在形・命令形で残る記述も当時の契約を正確に保存するための
引用範囲で、現行DJ PC、launcher、JSON、MIDI Learn、F13/F14、またはSyndocalへ適用しては
いけません。現行production authorityは本書冒頭と次節以降のproduct source 1.1.12 / v1.1.11 any-deck strict-v3だけです。
この履歴範囲にはcurrent operator linkを置きません。

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

## CURRENT product source 1.1.12 / production v1.1.11 strict-v3 接続と状態同期

WebSocket接続後、クライアントは順に`DJ_AGENT_HELLO`、`DJ_STATE_SYNC`、
`DJ_TIMELINE_STATE_REQUEST`を送信します。再接続・再起動後も同じ順序で、
Syndocalは現在の権威状態を`DJ_TIMELINE_STATE`で返してください。状態が返る
まではtimeline actionを送らず、`timeline-control`中の切断は`dj-control`へ
自動復帰しません（安全側に停止します）。

`DJ_TIMELINE_STATE_REQUEST`はcontrol-onlyで、physical pending/replay registryには
入りません。hello後の自動requestと公開requestは、最新requestのeventId、sequence、
socket、connection generationだけを相関します。current socketの
`accepted`/`duplicate` ACKはrequest受理を示すだけで、snapshot readyを意味しません。
`rejected`/`no_mapping`/`busy`またはcode付きのcurrent ACKは、固定allowlistのcodeだけを
使ってsanitizedなlastError/messageとvisible warning/control failureへ反映します。
foreign/stale/old-socket ACKは無視し、validなcurrent `DJ_TIMELINE_STATE`でrequest相関を
解除します。

Reconnect replayはfail-closedです。socket close/errorを越えて保持できるのは、payloadの
`timelineId`/`playSessionId`/`state:"released"`とeventIdが一致するpending
`DJ_RELEASE`だけです。同じeventIdとsemantic payloadのまま、current socketのmatching
ACK（`accepted`/`duplicate`）または、`state:"running"`、`pedalOwner:"timeline"`、
同じtimelineId/playSessionId/releaseEventIdを持つexact authoritative snapshotまで待ち、
replay時だけ新connectionのsessionId/sequenceを使います。ACTIVE、LOOP_STATE、
LOOP_FALLBACK、TIMELINE_BEAT_JUMP、TIMELINE_LOOP_SETなど他のphysical eventはteardown
直後にterminal `send-failed`（connection-closed/connection-error/stopped）となり、再送しません。
同一connection generation内でtimeline sessionがAからBへ遷移した後は、Aの
sequenceが新しくてもAはretiredとして受理しません。これはABA再keyingとReleaseの
誤terminal化を防ぐbounded fenceで、connection generationの置換時だけresetします。

`DJ_TIMELINE_STATE`の形式は次です。

```json
{
  "v": 3,
  "type": "DJ_TIMELINE_STATE",
  "agentId": "syndocal",
  "sessionId": "syndocal-session",
  "sequence": 42,
  "eventId": "timeline-state-42",
  "payload": {
    "state": "running",
    "loopActive": false,
    "transitionHoldActive": false,
    "timelineId": "show-2026-08-21",
    "positionBars": 128,
    "playSessionId": "play-session-42",
    "pedalOwner": "dj",
    "releaseEventId": null,
    "operatorReturnRequestId": null
  }
}
```

payloadの現行形は上記9フィールド固定です。`operatorReturnRequestId`は`null`または
`syndocal-dj-operator-return-<epoch>-<counter>`のexact canonical IDだけです。
`<epoch>`は32文字のlowercase ASCII hex、`<counter>`はleading zeroなしの
`1..18446744073709551615`（u64::MAX）canonical decimalです。このfieldの欠落、
空文字、端空白、control文字、型違い、arbitrary/noncanonical ID、およびその他の
extra fieldはstrict-v3としてfail-closedに拒否します。
`transitionHoldActive`は必須booleanです。generic `running`だけではペダル所有権を
移しません。`pedalOwner:"timeline"`、現在のplaySessionId、同sessionの相関済み
DJ_RELEASE eventIdがすべて一致した時だけ`timeline-control`へ移ります。RELEASE後の
late TRACK_SYNC/LOOPはsession fenceで破棄し、所有権を再取得できません。
Syndocalが新しいnon-null `operatorReturnRequestId`を送ると、rb-outputは現在の候補を
一度だけ`requestCurrentTrackCandidates()`で再告知します。これはローカルownerを変更せず、
通常どおり`DJ_TRACK_ACTIVE`のcurrent ACKだけがadmissionを決めます。同じepochでは
BigInt counter high-waterを接続世代をまたいで保持し、lower/equal replay（257件超を
含む）は再告知しません。別epochは別のauthoritative Timeline `sessionId`でのみ受理し、
同一sessionのepoch切替は拒否します。受理済みの旧epochはretiredとして永久拒否し、
retired epoch台帳は64件で容量ラッチしてfail-closed（evict/reopenなし）です。rejected
ACTIVEも未admittedのままvisible/actionableです。
Web Agentの`authorityConsistency`が不一致を`SYNC REQUIRED`として表示しますが、Web側の
operator return操作をこの相関だけで自動実行しません。明示的なreturn操作はSyndocal側の責務です。
Syndocal handoffを有効にした構成で初期接続中、接続後snapshot待ち、切断中、再接続
直後でも、Stage 1のF13/F14が既存のローカルRekordbox MIDI操作を継続できるのは、
terminal `accepted`/`duplicate`の`DJ_TRACK_ACTIVE` ACKで既にadmit済みのownerだけです。
fresh candidateはACK前にはadmitされず、切断中のoffline pathから新規admitされません。
この間のネットワーク側effectはpendingまたはfailedとして記録し、snapshot待ちを理由に
既にadmit済みのlocal操作だけを止めません。
Stage 2のtimeline操作だけは接続済みかつ権威snapshot確定時までfail-closedです。

## CURRENT product source 1.1.12 / production v1.1.11 Stage 1: Rekordbox操作とhandoff

product source 1.1.12のv1.1.11 production contractは`releaseMacro.enabled:true`かつ
`sequence:"filter-then-fade-then-stop"`だけを受理します。Stage 1のF13はadmitted
owner deckのFilter HPF（CC16、64→127、1000ms、50ms間隔）を同期開始し、同じ初期edgeで
相関済み`DJ_RELEASE`を一度だけrouteします。ReleaseはFilter/fade/Stop/resetなどの
ローカルMIDI成否から独立し、その後のローカル順序はHPF完了→ChannelFader（CC17、
127→0、1000ms、50ms間隔）→Cue/Stop Note37です。Filter/fade/Stop/resetのfailureは
表示したまま、Releaseを省略・duplicateしません。Stop後だけFilter 64とFader 127へ
best-effort resetします。別sequence、direct-Stop fallback、fadeなし経路はありません。
F13のACK/rejected/timed-out/send-failedとlocal failureは同じcanonical eventIdで別々に
表示し、失敗を成功へ昇格させません。ACKだけではStage 2に入りません。F14は従来の
LoopHalf、F15はStage 1ではinactive（MIDIもSyndocalも送信しない）です。

推奨Learn例（CustomMIDI1、1-based channel）は次です。

| 用途 | Deck 1 | Deck 2 |
| --- | --- | --- |
| LoopHalf | CH1 Note36 (`0x90 0x24 0x7f`) | `deckChannels`設定時CH2 Note36 (`0x91 0x24 0x7f`) |
| Cue/Stop | CH1 Note37 (`0x90 0x25 0x7f`) | `deckChannels`設定時CH2 Note37 (`0x91 0x25 0x7f`) |
| Filter HP | CH1 CC16 (`B010`) | `deckChannels`設定時CH2 CC16 (`B110`) |
| ChannelFader fade | CH1 CC17 (`B011`) | `deckChannels`設定時CH2 CC17 (`B111`) |

v1.1.11 CSVはChannelFader CC17（`B011`/`B111`）を含み、strict launcherはFilter
CC16、fade CC17、enabled fade、exact duration/value/deck-channelを要求します。実機のLearn結果が異なる場合、この
controlled sourceを推測で別CCへ切り替えず、fail-closedで新しいevidence trancheを開始します。

### showEventRouterの分割境界

公演前の今回のtrancheでは`showEventRouter.js`の大規模な抽出を延期します。
authority、delivery、play-session、shutdown generation、public action emissionが同じ
経路で結合しており、deadline前の分割はNO-GOです。将来の低リスク抽出先は
`server/dj-agent/releaseMacro.js`とし、ramp/timer/local-failure/Stop-reset/generation
だけを所有します。routerはauthority、delivery、session fence、public emission、shutdownを
保持し、Stage 2 timeline-controlの意味は変更しません。

## CURRENT product source 1.1.12 / production v1.1.11 Stage 2: absolute loop toggle、F14 LOOP_HALF、F15 +4

`running`後のtimeline-controlはproduct source 1.1.12の現行v1.1.11 production contractの
別境界です。すべてACK対象で、Stage 2では
Rekordbox MIDIを一切呼びません。Stage 2の物理受入はStage 1のRelease実機証跡とは別で、
現時点では未受入です。

| Pedal | outbound | payload |
| --- | --- | --- |
| F13 | `DJ_TIMELINE_LOOP_SET` | 現在の `loopActive` の反対を送る `{ "active": true\|false, "timelineId": "...", "playSessionId": "..." }`。通常のauthoring loopとpost-Follow holdは同じabsolute toggle |
| F14 | `DJ_TIMELINE_LOOP_HALF` | active loop時だけ `{ "timelineId": "...", "playSessionId": "..." }`。inactive/unknownはfail-closed、Rekordbox MIDIなし |
| F15 | `DJ_TIMELINE_BEAT_JUMP` | `{ "bars": 4, "timelineId": "...", "playSessionId": "..." }` |

両commandのpayloadは上表のexact fieldだけからなり、`timelineId`と`playSessionId`には
権威`DJ_TIMELINE_STATE`が示す現在値をそのままstampします。encoderは未知fieldを1つでも
受け取りません。内部だけが持つ出典marker `source:"pedal"`はexact一致でのみ許容され、
wire frameへはstripされます。送信frameにlocal由来のfieldは現れません。権威
`DJ_TIMELINE_STATE`の受入は同一session内では`sessionId`+`sequence`によるstaleness fenceで
判定し、stale/equal sequenceは状態を変えずに破棄します。再接続で新しいconnection
generation/sessionIdになるとfenceは再keyingされ、旧sessionとの比較は行いません。
`transitionHoldActive`はstrict snapshotの診断値として保持しますが、F13のgateには使いません。
F13はloop unknown、pending F13 loop-set、切断、snapshot不足、または相関不成立では
visible reasonを残して一切送信しません。F14はactive loopでない場合、または自分の
LOOP_HALFがpendingの場合にfail-closedします。F13とF14は独立したpending latchを持ち、
一方のACK/rejection/reconnect terminalで他方を解放しません。同じeventIdのterminal
outcome（rejected/timed-out/send-failed）、またはF13なら同じtargetとdesired valueを
示す次の権威snapshotだけが該当latchを解放します。別target・stale snapshot・foreign
terminal outcomeは保留を解放しません。skipまたはterminal失敗したcommandは次の同じ
操作を妨げず再試行可能です。F15だけがbeat jumpを送れ、encoderは`+4`だけを
許可します。`-4` beat jumpはretiredでrejectします。
ACK成功だけで権威状態を書き換えず、次の`DJ_TIMELINE_STATE` broadcastを
待ちます。time signatureとbar gridはSyndocal側が決定し、`bars`は音楽的な
小節数（秒数ではない）です。

### Operator return boundary

Web Agentは診断専用であり、`Return to DJ control`ボタンやlocal owner
overrideを持ちません。TimelineとDJ候補の世代・owner/sessionが食い違う場合は
`SYNC REQUIRED`を表示するだけです。オペレーターのreturn操作はSyndocal側の
明示操作で行い、Syndocalが現在の権威snapshotへboundedな
`operatorReturnRequestId`を付けます。canonicalな
`syndocal-dj-operator-return-<epoch>-<counter>`（epoch=32 lowercase ASCII hex、
counter=canonical decimal 1..u64::MAX）は、同一epochならBigInt high-waterを
接続世代をまたいで保持します。別epochは別のauthoritative Timeline `sessionId`でのみ
受理し、旧epochはretiredとして永久拒否します。retired epoch台帳は64件で満杯になった
時点で容量ラッチし、evictして再開することはありません。現在候補は一度だけ
`DJ_TRACK_ACTIVE`として再告知し、同じIDのreconnect snapshotではgeneric
reannouncementへフォールバックしません。
ローカルownerを直接設定する経路はなく、通常の`DJ_TRACK_ACTIVE`のterminal
`accepted`/`duplicate` ACKだけがadmissionを決めます。rejected/ambiguous/stale
candidateは未admittedのままvisible/actionableです。旧
`POST /api/dj-agent/actions/return-to-dj-control` routeとconfirmation bodyは
削除され、存在しないため404です。

## CURRENT product source 1.1.12 / production v1.1.11 v3 eventId・ACK・順序

すべての送信eventに一意eventIdと単調増加sequenceを付けます。受信側は
eventIdで冪等処理し、同じIDを二重適用しません。v3 ACKは次の7フィールド固定です。

```json
{
  "v": 3,
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

送信直後は`pending`であり、`ok:true`ではありません。`retrying`と`disconnected`は
再接続/replay待ちのnon-terminal状態ですが、current product source 1.1.12のv1.1.11
production contractでこの境界を越えられるのは
相関済み`DJ_RELEASE`だけです。他のphysical eventはsocket teardown時点でterminal
`send-failed`となり、replayしません。最終deliveryは`acknowledged`、`rejected`、
`timed-out`、`send-failed`のいずれかです。UI/APIはpending・success・failureを同じ
action eventIdで表示します。

典型的な順序は次です。

1. Syndocal側ですでに対象timelineが再生中であり、DJ PCは権威の
   `DJ_TIMELINE_STATE(state:"running")` snapshotを受け取る（rb-outputがtimelineを開始しない）。
2. F13の初期edgeでowner-deck HPFを開始し、同じedgeの相関済み`DJ_RELEASE`を一度だけ送る。
3. Syndocalは`DJ_RELEASE`に対してTimeline loopをOFFにし、DJ clock ownershipを relinquish
   して現在bar位置から自然継続する。即時のstart/play/seek/jump/advance/stopは行わない。
4. 相関済み`DJ_TIMELINE_STATE`が`timeline-control`を確定した後だけ、Stage 2のF13/F14/F15を
   送信する。F13はcurrent `loopActive`の反対を`DJ_TIMELINE_LOOP_SET`で送り、F14は
   active loopだけを`DJ_TIMELINE_LOOP_HALF`で送り、F15は`+4` beat jumpである。
   `-4`はretiredである。
5. 終演・停止・resetを`DJ_TIMELINE_STATE`でbroadcastし、`dj-control`へ戻す。

切断・ACK timeout・不正state・bar grid不一致は成功扱いにせず、warningと
last deliveryに残してください。物理機器未接続でもNode本体は継続起動し、
必要な境界だけ`unavailable`/`send-failed`になります。
