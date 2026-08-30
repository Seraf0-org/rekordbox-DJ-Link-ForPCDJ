# Rekordbox DJ Link for PCDJ

Rekordbox 7.2.13、7.2.14、7.2.18 と Pioneer DJコントローラー（FLXシリーズ等）環境における、**低遅延Now PlayingおよびBPMリアルタイム配信システム**です。

Rekordbox のプロセスに専用のDLL (`rb_hook.dll`) を注入し、内部関数を直接フックすることで、ポーリングファイル監視では実現できない0秒遅延の楽曲状態の取得とWebサーバーでの統合表示を行います。

## Current show-source authority — product source 1.1.12 / production v1.1.11 any-deck strict v3 (2026-08-30)

The only current Syndocal adapter is `syndocal-envelope-v3`; every frame is the
exact `{v:3,type,agentId,sessionId,sequence,eventId,payload}` shape. Flat, v1,
and v2 adapters/frames are retired and fail closed. Product source metadata is
`1.1.12`; no v1.1.12 installer/tag/public release or hardware acceptance is
claimed here. The production schema, external config, and CustomMIDI1 CSV remain
the v1.1.11 contract. Use an approved source checkout, an external
`DJ_AGENT_CONFIG_PATH`, and no-argument `start-all.bat`. The only tracked
token-free template is `config/dj-agent-v1.1.11.example.json`; exact
`start-all.bat --init-config` creates only
`C:\SyndocalShow\dj-agent-v1.1.11.json` when absent. It never overwrites,
copies, deletes, or reads the deployed historical
`C:\SyndocalShow\dj-agent-v1.1.5.json`, and it performs no build, server,
Rekordbox, or injection action.

The reviewed v1.1.7 any-deck boundary is historical and superseded; the
controlled product-source 1.1.12 tranche is the current controlled-source
checkpoint based on that earlier boundary and retains the v1.1.11 production
schema/config/CSV contract. This section does not claim an installer,
tag, public release, deployment, or physical acceptance. The HW-4 matrix
remains 0/12.

An exact mapped track may now be admitted from **any actually playing
Rekordbox deck**. `DJ_TRACK_ACTIVE` is emitted once per admitted deck,
deckId, and playSessionId with exactly one identity (`contentId`, or exact
title + artist); `DJ_TRACK_SYNC` may only advance that same owner and identity.
That wire identity freezes with the first emitted ACTIVE for the session; late
metadata enrichment remains diagnostic and cannot change subsequent ACTIVE or
SYNC identity.
Rekordbox MASTER/master-change remains diagnostic and never grants show-control
ownership. An unmapped, foreign, stale, conflicting, or identity-incomplete
candidate fails closed without replacing the admitted owner. The current operator import
artifact is `server/public/setup/CustomMIDI1-Syndocal-v1.1.11.csv`; the
v1.1.5 CSV/config and its deployed observations are historical evidence only.

The controlled v1.1.11 external JSON must contain the exact
`trackActivity.ownerSelection` policy (`mode:"titleContains"`, NFC/case-sensitive
`titleNeedle:"人生オーバー"`, `deck1MetadataWaitMs:1400`). A missing, legacy, or
modified policy fails strict launcher readiness; it never silently falls back
to content-first selection. The selector itself ignores artist, but a matching
title cannot enter the v3 network path until Rekordbox also supplies artist:
v3 text identity is always title **and** artist, and contentId cannot bypass
that prerequisite for a matching title. With two or more positive titles, a
fresh actually-playing transport-valid Deck 1 wins (even if its own title is
not positive); if Deck 1 is unavailable, the lowest transport-valid positive
deck wins. With zero title matches, a fresh actually-playing Deck 1 may use its
complete text identity (or contentId only when text is unavailable) after 1400
ms. That leaves an explicit 100-ms
dispatch reserve inside the v3 1500-ms freshness bound; a later timer fails
closed rather than sending stale data.

Stage 1 separates Rekordbox MIDI from Syndocal delivery. Physical F14 arms the
response window before the MIDI send. Fresh measured Rekordbox loop state is
primary. Only true no-response emits `DJ_LOOP_FALLBACK`, using
`8 → 4 → 2 → 1 → 1/2 → 1/4 → 1/8 → 1/16 → 1/32 → 1/64` and stopping only at
`1/64`. Invalid, stale, or contradictory same-lineage responses suppress the
fallback, and a late fresh measurement rebases it. Physical F13 synchronously
starts the owner-deck Filter HPF (64→127 for 1000ms) and routes exactly one
correlated `DJ_RELEASE` at that same initial action edge, before any ramp
completion or Stop. Local MIDI then runs in order: HPF → ChannelFader fade
(CC17, 127→0 for 1000ms) → Cue/Stop Note37. Filter and fader reset to 64 and
127 after Stop. Syndocal delivery/ACK is independent of every local MIDI
result. ACK alone never enters Stage 2; only authoritative correlated running
state does. In Stage 2, F13 sends one absolute `DJ_TIMELINE_LOOP_SET` with the
opposite of the exact authoritative `loopActive` value: authored loops and
post-Follow transition holds use the same toggle, while `transitionHoldActive`
remains a strict diagnostic field. F14 is an independent, active-loop-only
`DJ_TIMELINE_LOOP_HALF` action carrying the exact `timelineId` and
`playSessionId`; it never sends Rekordbox MIDI. F15 is the only beat jump (`+4`),
and the retired `-4` beat jump is rejected by the encoder. Each timeline action
has its own pending/ACK latch. These are software gates only;
controller/pedal/Rekordbox/wired-Syndocal acceptance remains exactly **0/12**.
Each fallback carries a monotonic `pedalIntentId` plus the exact measured
revision and effective loop-division base. The strict-v3 sender nests measured
loop truth under `payload.loop`, matching Syndocal ingress; the retired flat
wire shape is rejected.

### Explicit standalone Rekordbox local test — `REKORDBOX LOCAL TEST / NO SYNDOCAL`

Product source `1.1.12` also provides an explicit standalone mode for testing
the existing Hook/Rekordbox candidate, MIDI, pedal, and router path without a
Syndocal peer. This is a test-only mode, not a relaxed production route. Its
fixed external config is
`C:\SyndocalShow\rb-output-rekordbox-local-test-v1.json`; it does not read
`DJ_AGENT_CONFIG_PATH` or any other environment-selected config. The local UI
binds only to `http://127.0.0.1:8787`. No token, NIC selection, or Syndocal
network connection is used, and status/action delivery is shown as exactly
`not-applicable/local-only`.

Run these commands from the checkout root on the controlled Windows DJ PC:

```powershell
.\start-all.bat --init-rekordbox-local-test
.\start-all.bat --preflight-rekordbox-local-test
.\start-all.bat --rekordbox-local-test
```

`--init-rekordbox-local-test` creates the fixed external JSON only when it is
absent. Before writing it, the initializer enumerates MIDI outputs and requires
exactly one valid `CustomMIDI1` entry with an integer port in `0..4096`, then
stores that entry's current port;
it never guesses a port or overwrites an existing target. The initializer also
requires the restrictive Windows ACL for the target. The preflight command
re-enumerates `CustomMIDI1` and requires one-and-only-one match to the stored
device/port. It starts no build, server, Rekordbox, Hook, MIDI, or pedal action.
The full-runtime command performs the Hook rebuild/provenance check, restarts
the same-mode local source server, injects the Hook into an installed supported
Rekordbox process, and opens the loopback UI. Before launch, after any eligible
same-mode listener stop, immediately before spawn, and once more after the new
child owns the requested listener but before launcher success, the restart gate
enumerates exact-checkout `node` source processes across **all ports and launch
states**, including pre-listen processes. An opposite-mode process is always
reported with its PID and mode and fails closed; it is never terminated
automatically. A same-mode process is restartable only when it owns the
currently requested port in `LISTEN`; a same-mode process on another port or in
pre-listen state is never terminated automatically. Stop any such process
explicitly and rerun the same mode.

The same source-process fence applies to the normal no-argument production
launcher and to this explicit local-test launcher; the mode-specific command
is not a port-only ownership boundary.
Direct/manual `node` launches outside `start-all.bat` remain operator-owned:
stop them explicitly before using the controlled launcher.

The local owner gate is deliberately narrow: an action is allowed only for the
current fresh, actually playing candidate with the exact admitted deck,
`deckId`, `playSessionId`, and frozen identity. The selector is
`titleContains` with NFC/case-sensitive `人生オーバー`. If that title does not
match, only a fresh playing Deck 1 may become the bounded fallback after
`1400 ms`; stale, stopped, foreign, replaced, or identity-incomplete candidates
remain blocked. F14 runs local LoopHalf handling. F13 runs the local macro in
this exact order: Filter HPF (CC16, 64→127 over 1000 ms) → ChannelFader fade
(CC17, 127→0 over 1000 ms) → Cue/Stop Note37 exactly once, then resets HPF to 64
and the fader to 127 after Stop. Each phase revalidates the frozen local owner;
a replaced, stopped, stale, or foreign session cancels the remaining macro and
cannot receive fade, Stop, or reset intended for the prior session. Timeline/
Stage 2 is unavailable in this mode; no `DJ_TIMELINE_*` event is sent.

This local path does not change the normal no-argument production command. In
production, a fresh candidate must first receive a terminal `accepted` or
`duplicate` `DJ_TRACK_ACTIVE` ACK from Syndocal before it is admitted and can
drive local MIDI. During a disconnect, production local MIDI continues only for
an owner already admitted by that terminal ACK; a fresh no-Syndocal candidate is
never admitted by the offline path.

No physical acceptance is claimed for this mode. Remaining evidence is the
controlled-DJ-PC check of one unique `CustomMIDI1` output and its actual port,
Rekordbox Learn/output for LoopHalf, HPF, ChannelFader, and Cue/Stop, live Hook
track identity and the `人生オーバー`/Deck 1 `1400 ms` selection cases, F14
measured-loop behavior, F13 timing/order/reset, rejection of stale or foreign
owners, loopback-only UI/status showing `not-applicable/local-only`, and the
separate normal production terminal-ACK/disconnect behavior.

### One-way show-config upgrade

If an existing controlled DJ PC still has the exact v1.1.10 external source,
set `DJ_AGENT_CONFIG_PATH` to that file and run:

```powershell
.\start-all.bat --upgrade-config
```

The migration accepts only that known strict predecessor, requires an absolute
external regular non-link source, carries forward only its valid Syndocal token,
and creates `C:\SyndocalShow\dj-agent-v1.1.11.json` exclusively from the
bundled token-free v1.1.11 template. The predecessor remains byte-for-byte
unchanged; no token or config content is printed. The launcher immediately
runs the current strict preflight against the new target, prints the exact
PowerShell assignment for the next invocation, and does not start the runtime
in the migration invocation. This is one-way tooling only: after every
controlled DJ PC has adopted v1.1.11, remove the predecessor migration path.

The exact `C:\SyndocalShow` parent must not grant broad write access to
Everyone, Authenticated Users, or BUILTIN\\Users. The updater never changes the
parent ACL automatically. An unsafe parent fails before target creation with the
fixed reason `PARENT_ACL_UNSAFE`; other secure-writer failures likewise expose
only an allowlisted reason code and never print the token or configuration.
The Windows parent handle permits ordinary read/write sharing but deliberately
omits delete sharing, while the exclusive target handle remains live through
durable flush.

Reconnect replay is fail-closed: only a pending, exactly correlated
`DJ_RELEASE` may cross a socket close/error. It keeps its eventId and semantic
payload until a matching current-socket ACK or exact authoritative running
timeline snapshot; every other pending physical event is terminal
`send-failed` and is never replayed. Within one connection generation, a
timeline session ID retired by a later accepted session can never be accepted
again, even with a higher sequence; a replacement connection resets that
bounded fence. `DJ_TIMELINE_STATE_REQUEST` is control-only: accepted/duplicate
means request accepted, not snapshot readiness, while current rejected/no_mapping/
busy/code failures are surfaced with sanitized status and warning data.

## SUPERSEDED / DO NOT EXECUTE — v1.1.3 リリースノート（immutable historical release evidence）

公開済みimmutable v1.1.3は履歴・provenance evidenceだけです。内部の
`DJ_MASTER_CHANGED` mismatchがstrict-v2 clean-breakのnegative proofを阻むため、
現行final artifactとしてinstall、接続、受入れに使ってはなりません。現在の実行可能な
operator guidanceは、この履歴節ではなく上記v1.1.11 any-deck strict-v3節だけを使います。

Syndocal公演同期を`syndocal-envelope-v2`へclean breakし、配布物の真正性検証
（provenance）も大幅に強化しました。

* **strict show-sync v2**（historical v1.1.3 contract evidence）: 旧flat/v1 adapterを
  退役し、exact master deck、playSessionId、track identity、position、BPM、revision、
  freshnessが揃った時だけACTIVEを送信します。継続TRACK_SYNC、`active`/`startBeat`/
  `endBeat`/`lengthBeats`/`revision`/`sampleAgeMs`/`rekordbox-hook-measured`を持つ
  実測loop 8/4/2、相関済みRELEASEをstrict v2 envelopeで固定しました。ACK前の
  physical eventだけが同一eventId/semantic payload/playSessionIdを接続世代間で保持し、
  TRACK_SYNCは再接続後にreplayせず新世代で再取得します。欠落、null、非有限、古い
  sample、reorder、旧wireは明示的にfail-closedします。
  TRACK_SYNCは非ACKの連続telemetryとして定数メモリのsession-local IDを使い、
  durable physical ID台帳を消費せず、reconnect後にはreplayしません。

* **exe本体へのprovenanceバインディング**: パッケージング前に正準リリースidentityと
  コミットメントを生成し、そのコミットメントをserver.exe自体にコンパイル同梱します。
  パッケージ後にsidecar (`build-identity.json`) が実測したexeのSHA-256を束ねます。
  起動時は「exe内蔵コミットメント ↔ sidecar identity」「実行中exeの実測ハッシュ ↔
  sidecar binding」を検証し、全て成立するまで `verified-packaged` を表示しません
  （旧リリースの再再生・外部coherentセットの持ち込みは起動前異常終了）。
* **`server.exe --verify-install`**: インストール済みツリー（install-manifest、
  identity、exe束縛）をサーバー起動なしで検証するモードを追加。`start-rb.bat` は
  通常起動の前にこの検証を行い、失敗時は起動しません。システムNodeに非依存です。
* **注釈付きタグ必須**: リリースpreflightは `git cat-file -t` で対象がannotated tag
  オブジェクトであることを要求し、lightweight tagを拒否します。
* **ツールチェーン固定**: `npm ci`（lockfile厳密）、pkgは `@yao-pkg/pkg@6.22.0` の
  ローカルpin呼び出しのみ（`npx --yes`廃止）、`python/requirements.txt` は
  PyInstaller/psutil含め完全ピン留め。未ピンのpip installは廃止しました。
* **マニフェスト経路強化**: スラッシュ/バックスラッシュ両方のtraverse、ドライブ文字、
  UNC、絶対パス、重複エントリ、正規化脱出、予約デバイス名、シンボリックリンクを
  fail-closedで拒否します。
* **配布物**: ZIPを常に生成し、Inno Setupがある環境ではインストーラーと両方を1つの
  `dist/release-manifest.json` に束ねます。生成物はすべて `dist/` 配下に出力され、
  再実行してもワークツリーが汚れません。

### SUPERSEDED / DO NOT EXECUTE — v1.1.3 first-run Setup / live checkpoint (2026-08-25 historical)

このSetup/live checkpointはimmutable v1.1.3の履歴です。内部`DJ_MASTER_CHANGED`
mismatchのため、現行受入れ用のinstall/setup手順ではありません。修正済みplanned
v1.1.4がtag・公開されるまで実行しないでください。

初回セットアップカードはDJ Agentがdisabled、未設定、またはnative device未接続でも
常時表示されます。カードが使用する `GET /api/dj-agent/setup` はDJ PC上の
localhost専用のread-only GETです。request peerがloopbackであることに加え、Hostが
localhost/loopback、Originが空またはlocalhost/loopbackであることを同時に検証し、
いずれかが不成立なら403を返します。LAN向けの通常status/read-only APIとはこの境界を
混同しません。

カードはtoken入力・token表示・localStorage保存・サーバーへの設定POST/変更を持たず、
preview/download/copyするJSONもtoken-freeです。versioned artifact
`CustomMIDI1-Syndocal-v1.1.3.csv` はカードからダウンロードし、RekordboxのMIDI
Learn/CustomMIDI1へoperatorが手動でimportします。driver、virtual MIDI、Rekordbox、
Elgato/Stream Deckの外部操作は自動実行せず、画面上のguided confirmationの対象です。
カード上で案内する入力はSyndocal host、local NIC、MIDI output、adapterです。
CSVの検証済み要点は `CFXParameterCH1=B010`、`CFXParameterCH2=B110`、
`Cue=9025/9125`、`LoopHalf=9024/9124`です。

MIDI outputは、列挙された同一optionの非空device nameとsafe integer portが一致した
場合だけ既存選択を反映します。`null`/空/boolean/数値文字列をportとしてseedせず、
port 0を暗黙選択しません。adapterは初回必ず未選択です。device/portは既存設定が
あり、列挙結果のname+portへ完全一致する場合だけ反映し、それ以外は未選択にします。
operatorがこのページで明示選択した後だけpreviewへ反映します。同一ページのrefreshでは
触った選択を維持しますが、name+portが列挙結果から消えた場合はplaceholderへ戻して
fail-closedにします。出荷・現行productionの唯一のadapterは
`syndocal-envelope-v2`です。未設定時もv2です。
旧flat `generic-json`と `syndocal-envelope-v1`は明示的に拒否し、互換選択肢として
残しません。

2026-08-25のDJ PC live preflightは受入れ完了を意味しません。

| surface | live fact |
| --- | --- |
| peer | 旧buildのpeerはSetup endpointが404 (`peer old build 404`) |
| local Agent / MIDI / pedal / hook | いずれもOK |
| Syndocal | 現在disabled。send-failed境界も観測済みで、接続成功とは扱わない |
| physical acceptance | **0/12**。ハードウェア受入れは未実施 |

MinHook pinおよび`build-dist`経路の最終レビューはpendingです。このcheckpointでは
それらの完了や、上表のlive factsからのhardware acceptanceを断言しません。

## SUPERSEDED / DO NOT EXECUTE — v1.1.1 リリースノート（historical）

This release note is retained for provenance only. Do not use its old wire, package,
or smoke observations for current acceptance; immutable v1.1.3 is blocked and the
corrected v1.1.4 strict-v2 release is planned, not yet tagged or published.

Rekordbox 7.2.18での実機検証を進め、Web表示とHook連携を安定化しました。

* クロスフェーダーとDeck 1/2のチャンネルフェーダー量をRekordbox内部から取得し、Web UIとAPIへリアルタイム配信。
* Track BPMの一時的な欠落、再生時間の遅延、ページ再読み込みが必要になる問題を修正。
* Time欄へ波形付きシークバーを追加し、ループ区間の設定と実際のループ動作を区別。
* Warningsの折りたたみ、全体幅レイアウト、カスタムスクロールバー、リポジトリ・クレジット付きフッターを追加。
* WebサーバーによるRekordboxの定期監視、自動起動、自動再注入を廃止。Rekordbox再起動後の注入は明示操作のみ。
* 当時の旧Syndocal wireとbuild identityを追加（現在はstrict v2へclean break済み）。
* npmとPython依存関係の既知脆弱性監査は0件。Nodeテスト69件、Hook DLLビルド、Rekordbox 7.2.18実機接続を確認済み。

## SUPERSEDED / DO NOT EXECUTE — v1.1.0 リリースノート（historical）

This release note is retained for provenance only. Do not use its old wire, package,
or smoke observations for current acceptance; immutable v1.1.3 is blocked and the
corrected v1.1.4 strict-v2 release is planned, not yet tagged or published.

既存のNow Playing本体との後方互換を保ったまま、Rekordbox連携と任意の
DJ Agent拡張を強化しました。

* Rekordboxの最新インストール検出と、Loop状態・未知イベントの診断経路を追加。
* DJ Agentは既定OFFのoptional拡張として統合。未接続のSyndocal、MIDI、または
  global hotkey adapterがあっても本体の起動を妨げません。
* master deckに応じたdeck-aware MIDI channel routingを追加。
* ペダルを2段階制御化した過去の設計記録。現行のmacro/CC設定として再利用しないこと。
  現行のStage 1/Stage 2ペダル意味論は本README冒頭のproduct source 1.1.12 / v1.1.11 production契約だけを参照し、
  この履歴節の旧割当・旧timeline操作は実行しません。
* Syndocal handoffはtimeline-controlだけをsnapshot待ち・切断・再接続時にfail-closedにし、eventId/sequence/
  ACK・pending/rejected/timed-out/send-failedを状態とUIへ反映。
* read-only APIは従来どおりLANから利用でき、DJ AgentのPOST actionは既定でloopback限定。

検証済み範囲は、Node test 54/54、JavaScript構文・差分検査、optional MIDI/global-hotkey
adapterの未接続時継続起動です。2026-08-23に `npm run build:dist` 相当の配布スクリプトを
完走し、`dist/server.exe`（SHA-256
`339ECF6E82EB463F55977F63A137CB0CB52886CD7E2874E87F5AD4724234377B`）と8エントリの
`dist/rb-output-20260823.zip` を生成しました。packaged serverは隔離ポート8788で起動し、
`/api/health`、`/`、`/api/dj-agent/status` のsmokeを通過しています。Rekordboxの
バージョン固有のhook署名、CustomMIDI1の物理Learn、Loop意味論、Syndocal/KDMXとの
相互運用は、対象環境での実機受入試験が別途必要です。

## DEPLOYED HISTORICAL / DO NOT EXECUTE — v1.1.5 record (2026-08-26)

The v1.1.5 controlled-source handoff, checkpoint
`ffd013c91f23df6ced84cd6daabc97266993dc34`, and its 0/12 hardware observations
are retained only as provenance. They are not a launch, configuration, token,
or acceptance procedure. The previously documented commands, historical path,
and twelve-row wake/acceptance sequence are intentionally omitted so this
record cannot be executed or mistaken for current guidance.

That record observed direct local Cue/Stop before `DJ_RELEASE`; it provides no
authority for v1.1.8. Current production authority is the v1.1.11 strict
`filter-then-fade-then-stop` contract in the product-source 1.1.12 section above;
hardware acceptance remains 0/12.

## SUPERSEDED / HISTORICAL — planned v1.1.4 strict-v2 guidance

This archived v1.1.4 plan is **not executable operator guidance**. Do not copy its
v2 frame, configuration, or release instructions into a current show setup. Current
production authority is the product-source 1.1.12 / v1.1.11 any-deck/v3 section above.
The immutable published v1.1.3 package
remains historical and blocked by its internal `DJ_MASTER_CHANGED` mismatch. The
v1.1.4 checkpoint H **(historical v1.1.4)** was
`c6ebb0fd917a82574b9ef61f12ebb41283db357e` on branch `beta-v1.1.2`; its tagged/public
release was never the current acceptance path, and hardware acceptance was **0/12**.

The archived plan specified the exact envelope
`{v:2,type,agentId,sessionId,sequence,eventId,payload}` and the exact control order
`DJ_AGENT_HELLO` → `DJ_STATE_SYNC` → `DJ_TIMELINE_STATE_REQUEST`. Syndocal's returned
`DJ_TIMELINE_STATE` was authoritative; timeline actions were fail-closed until its snapshot
was valid. Its historical accepted event set used a master-scoped track-active
event plus `DJ_LOOP_STATE`, `DJ_RELEASE`, `DJ_TIMELINE_BEAT_JUMP`, and
`DJ_TIMELINE_LOOP_SET`; its master-scoped track-sync was non-ACK telemetry.
This retained description is provenance only, not a v2 setup or wire instruction
for operators.

Its track frames carried deck identity, exactly one track identity form, optional
`trackBpm`, `positionAtSendSec`, `effectiveBpm`, `positionRevision`, `sampleAgeMs`,
`isPlaying:true`, `startedAt`, `playSessionId`, and an
optional measured-loop object. That object carries `active`, optional
`startBeat`/`endBeat`/`lengthBeats`, `revision`, `sampleAgeMs`, and source
`rekordbox-hook-measured`; no root-level loop-division counter was a v2 wire field.

The immutable v1.1.3 software/package evidence remains recorded for provenance:
source commit `5eaf1994e1bf4456857fefd36cc0ce827145b603`, annotated tag `v1.1.3` at
`24d38f6decbc8880149df1902ef8d2ccfe76b784`, full `npm test` 328 total / 326 pass /
0 fail / 2 intentional package-smoke skips, `node --check` 18/18, first-party warnings
0. These results do not make v1.1.3 current-final and do not close hardware acceptance.

## Core Features

* **リアルタイムHookングエンジン**
  * `LoadFile` 時の内部データを横取りし、曲がロードされた瞬間に情報を取得。
  * 常に変動するリアルタイムBPM、現在再生時間 (`@CurrentTime`)、総時間 (`@TotalTime`) などをラグなく同期します。
* **リッチな楽曲メタデータと波形プレビュー**
  * 従来のTitleとArtistに加え、データベース(`djmdContent`等)に直接アクセスし **アルバム、ジャンル、キー、レーベル、BPM、Track Number、コメント** などの詳細メタデータを即座に取得・同期します。
  * 楽曲の解析済みプロファイル (`ANLZ0000.DAT`) からプレビュー波形（PWAV）をリアルタイムに抽出し、UI上の時間シークバー領域に高精度な波形プレビューとして描画します。
* **高精度なマスターデッキ検知**
  * Rekordbox内部の `notifyMasterChange` 関数フックを利用した、確実なマスターデッキの切り替え検知（フォールバック検知も内包）。
* **ループ状態の検出・配信**
  * デッキごとのループ有効状態、開始/終了時刻、開始/終了ビート、ループ長を検出し、Web UIに表示します。
  * Socket.IO、HTTP JSON、Server-Sent Events (SSE) から他ソフトウェアでも取得できます。
* **柔軟なUI (ブラウザ配信)**
  * ダーク/ライトテーマ対応、任意のアクセントカラー設定。
  * **Sortable.js** を利用した、表示項目の自由なドラッグ＆ドロップ並び替え機能。
  * 必要な項目（Album, Genre, Key, Label, Time, Track BPM）の表示ON/OFF切り替え。
  * スマホ、タブレット、PCのどのサイズにでも対応するレスポンシブデザイン。

## DJ Agent 拡張 (product source 1.1.12 / strict v1.1.11 production contract)

Syndocal Show Control、pedal、Rekordbox MIDI は通常の Now Playing 本体から分離されています。
ProductionのDJ Agentを有効にできるのは、`start-all.bat --init-config` が作る checkout 外の
exact v1.1.11 `filter-then-fade-then-stop` 設定を `DJ_AGENT_CONFIG_PATH` で指定した時だけです。
前述の明示的な`REKORDBOX LOCAL TEST / NO SYNDOCAL`は、このproduction gateとは別の
固定test schemaです。
`DJ_AGENT_ENABLED`、inline JSON、`SYNDOCAL_*`、`MIDI_*`、`PEDAL_*` の環境変数は
runtime でも fail-closed になり、Agent は固定の secret-free reason とともに disabled のままです。
設定が無い状態でも first-run Setup と read-only HTTP/UI は起動を継続します。

唯一の production adapter は `syndocal-envelope-v3`、接続先 path は `/dj-link`、
heartbeat は 5000ms です。token は 32〜256 UTF-8 bytes、空白・Unicode control・
unpaired surrogate を含まない exact string だけを受理します。repository、ログ、
status へ token を保存・表示しません。Syndocal の権威 `DJ_TIMELINE_STATE` が有効になるまで
Stage 2 timeline 操作は fail-closed です。old flat/v1/v2 adapter、別名、環境 override、
legacy macro はありません。

次は2026-08-30公演のpre-release source acceptanceで使用する現在の構成です。
実ファイルはcheckout外（例：`C:\SyndocalShow\dj-agent-v1.1.11.json`）へ置き、
`<SYNDOCAL_ONE_TIME_TOKEN>`だけをSyndocalが表示した現在のtokenへ置換します。
tokenをrepository、スクリーンショット、ログへ保存しません。`MIDI_PORT: 1`はDJ PCの
Setup列挙で`CustomMIDI1`がport 1と表示された場合だけ正しく、列挙値が違えばその整数へ
完全一致で直します。名前だけ、推測値、暗黙port 0は拒否されます。

The canonical token-free source is tracked at
`config/dj-agent-v1.1.11.example.json`. Do not copy JSON out of this README.
From any checkout location, create the external file exactly once with:

```powershell
.\start-all.bat --init-config
```

The initializer resolves the template relative to its own checkout, writes only
`C:\SyndocalShow\dj-agent-v1.1.11.json`, and refuses to overwrite any existing
regular, invalid, or linked target. It never generates, reads, or prints a token.
The deployed historical `.15` target is outside this initializer's write scope.

For a pre-existing exact v1.1.10 external source, set
`DJ_AGENT_CONFIG_PATH` to that source and run
`.\start-all.bat --upgrade-config`. The one-way migration preserves only the
validated token, leaves the source unchanged, performs the current production v1.1.11
preflight against its exclusive target, and prints the next PowerShell-safe
assignment without starting the show runtime.

product source 1.1.12のv1.1.11 production contractは、tokenを置換した外部JSONについてだけ
`releaseMacro.enabled:true`、`sequence:"filter-then-fade-then-stop"`、Filter HPF
64→127/1000ms/50ms、ChannelFader fade CC17 127→0/1000ms/50ms、Cue/Stop
Note37、deck channel 1/2、両方のresetをexactに要求します。extra mapping、旧
`filter-then-stop`/`filter-then-fade`、direct-Stop fallback、別duration/value/channelは
launcher preflightでrejectします。Setup画面のtoken-free previewは
外部show sourceではなく、launch authorizationにも使用できません。
同じstrict readinessは`trackActivity.ownerSelection`にも適用され、
`titleContains` / `人生オーバー` / `deck1MetadataWaitMs:1400` のexact nested
object以外はrejectします。タイトル一致はartistを選択条件に使いませんが、v3送信は
title+artistの両方が届くまでfail-closedです。1400 msはv3 freshness 1500 msの
内側に100 msのtimer dispatch reserveを残す値であり、遅延時にsample ageを偽装しません。
title positiveが複数なら、fresh/playingかつtransport-validなDeck 1を優先し
（Deck 1自身のtitle positiveは不要）、Deck 1が使えない時だけ最小deck番号の
transport-valid positiveを選びます。identity不足、stale、停止、相関不能はこの
arbitrationの候補にならずfail-closedです。

2026-08-28のsource checkpointでは、Demo Track 2のロード時に新しい
`contentId=235403562`が届いた一方、直前の
`More One Night × 動く、動く (Agate Trance&Makina bootleg)`のtitleが
残る不整合を修正しました。`track_load`と有効なOLVC content-ID ingress
（`@TrackBrowserID`/`@ContentID`）で、異なる非空IDへの遷移を検出した時点で、
deckおよびglobal now-playingのtrack-bound metadataをsnapshot公開前に消去します。
同一IDのreplayと、nullからIDへのenrichmentは保持し、owner selectionが古いtitleを
再利用・再admitすることはありません。focused `node --test
tests/track-identity-transition.test.js` は **5/5** pass、これはsource-onlyの
checkpointです。対象DJ PCのpull/restart/reverify、mapped track、pedal、hardware、
installer/tag/public releaseは未確認・未主張です。

Productionのno-argument modeでは、exact external v1.1.11 configが無い場合は
Syndocal接続、MIDI、global-hotkey adapterを起動せず、SyndocalやMIDI機器が未接続でも
既存のHook UDP、Web UI、Socket.IO、HTTP APIは継続します。拡張を有効にした場合も、
/api/dj-agent/actions/loop-half、
/api/dj-agent/actions/filter-close、/api/dj-agent/actions/release、
/api/dj-agent/actions/track-active は物理ペダルと同じAction経路を使う診断用
エンドポイントです。Windows global hotkey adapter、MIDI transport、`ws` はいずれも
optional dependencyとして実行時に解決され、未導入なら該当機能を無効表示して本体を停止させません。
`ws` はSyndocal envelope transportだけに使われます。
読み取りAPIはLANから利用できますが、/api/dj-agent/actions/* のPOST action診断は
**恒久的にIPv4/IPv6 loopback限定**であり、DJ PC上のlocalhostからだけ到達できます。
判定は実際のTCP peerアドレスに基づき、Host/Origin/X-Forwarded-*や設定では
peerを偽装できません。旧env `DJ_AGENT_ALLOW_REMOTE_ACTIONS` とconfig-fileの
`allowRemoteActions` を含む別の設定値は受理しません。inline または環境 override が
一つでもあれば Agent 全体を固定の secret-free reason とともに disabled にします。
物理ペダルとglobal hotkeyはDJ PCローカルで動作し、FOH側のShow Controlは
トークン認証済みの `/dj-link` WebSocket経由で行います。この変更で、LAN向けの
read-only GET APIや既存のSocket.IOイベントが認証付きになったわけではありません
（両者は従来どおり無認証のままです）。現行v3の物理/control eventは
`DJ_TRACK_ACTIVE`、`DJ_LOOP_STATE`、`DJ_LOOP_FALLBACK`、`DJ_RELEASE`、
`DJ_TIMELINE_BEAT_JUMP`、`DJ_TIMELINE_LOOP_SET`で、これらはACK必須です。
`DJ_TRACK_SYNC`は連続する非ACK telemetryです。`DJ_MASTER_CHANGED` is retired/unreachable
(退役済み)で
v3のcapability setに含まれず、受入れ済みwire eventとして扱いません。公開済み
generic `DJ_STATE_SYNC` payloadは、未admit時の`{released}`、または
`{released,ownerDeck,ownerDeckId,activePlaySessionId}`だけです。ownerの3値は
all-or-noneであり、Rekordbox MASTERをshow-control ownerとしてwireへ載せません。
v1.1.3はこのencoder/router negative proofを満たさないためblockedです。訂正版
deployed historical v1.1.5 runtime checkpoint `ffd013c91f23df6ced84cd6daabc97266993dc34` は経路到達不能の
negative proofを持ちますが、current production v1.1.11 authority、installer、実機受入れとは別です。送信直後を成功扱いにせず、pending/acknowledged/rejected/timed-out/
send-failedを `/api/dj-agent/status` とUIに反映します。`accepted`/`duplicate`だけが
成功、`no_mapping`/`rejected`はterminal failure、`busy`だけが同じ`eventId`・
`sequence`・canonical v3 shape・socket generationのまま短い指数backoffで有限回
再送されます。型不足・未知outcome・`ok`不整合のACKはprotocol failureとして無視し、
ACK timeoutまでpendingを維持します。HELLO/heartbeat/State Sync/timeline requestは
physical ID capから分離したcontrol ID/sequenceを使い、再接続時に旧physical eventを
再送しません。timeline state requestのcaller-supplied eventIdは受け付けず、control
IDはプロセス内で生成します。

`DJ_RELEASE`だけは、同一payloadとcorrelationを持つcurrent authoritative running
snapshotが適用を証明した場合にもterminal完了できます。このsnapshot経路はACKを
捏造せず、他のphysical eventには適用しません。

Socket close/error replay is deliberately narrower than ACK retry: only a pending,
exactly correlated `DJ_RELEASE` may survive the teardown, retaining its eventId and
semantic payload until a matching current-socket ACK or an exact authoritative
correlated running `DJ_TIMELINE_STATE` snapshot proves it applied. A replay uses the
new connection session and sequence. Every other pending physical event
(`DJ_TRACK_ACTIVE`, `DJ_LOOP_STATE`, `DJ_LOOP_FALLBACK`, `DJ_TIMELINE_BEAT_JUMP`, or
`DJ_TIMELINE_LOOP_SET`) is immediately terminal `send-failed` with the teardown
reason and is never replayed. `DJ_TIMELINE_STATE_REQUEST` is control-only: the
automatic and public request paths share current eventId/sequence/socket-generation
correlation. A current `accepted`/`duplicate` ACK only means the request was
accepted; it does not establish snapshot readiness. Current `rejected`, `no_mapping`,
`busy`, or coded ACKs surface a sanitized status/message and visible timeline warning
or control failure; foreign, stale, and old-socket ACKs are ignored. A valid current
timeline state clears the request correlation.

State Sync providerがthrow、null、undefined、またはKDMX strict-v3 validationに失敗した
場合は、空snapshotへ置換せず、state-sync-error/send-failedとstatusへ記録してState
Syncもtimeline requestも送信しません。valid snapshotを送信できた場合だけtimeline
requestを続行します。
physical caller eventIdはプロセス中再利用不可で、既定262144件のbounded registryが上限到達時に
fail-closed latchします。sequenceはcontrolを含むsession wire high-waterより厳密に大きい
safe integerだけを受け付け、rollback/fraction/overflowは送信・予約しません。

明示的な`REKORDBOX LOCAL TEST / NO SYNDOCAL`だけは、Syndocal legを持たずに
ローカルMIDIを実行し、deliveryを`not-applicable/local-only`として表示します。
一方、productionのno-argument modeではfresh candidateのadmissionにterminal
`accepted`/`duplicate` `DJ_TRACK_ACTIVE` ACKが必須です。Syndocal handoffを
有効にした構成で初回接続中・再接続中・切断中でもローカルRekordbox MIDIが継続する
のは、そのACKで既にadmit済みのownerだけです。切断中にfresh candidateを新規admitする
offline fallbackはありません。`timeline-control`のStage 2操作は、接続済みかつ
snapshot確定時だけ送信します。
`idle`/`stopped`/`ended`/`reset`のsnapshotを受信するとStage 1へ戻ります。

product source 1.1.12のv1.1.11 production contractは`midi.deckChannels`をexact
`{"1":1,"2":2}`だけに固定します。LoopHalf、Cue/Stop、Filter HPF、ChannelFader fadeは
admitted owner deckのこのchannelだけへ送ります。未指定deckやmapping `channel`へのfallbackはありません。
実行中のaction resultには `targetDeck` と `targetChannel` が含まれます。Rekordbox MASTERは
診断のみでtargetを置換しません。KDMX strict-v3 envelope framesはstrict fieldsだけを送信し、
この診断情報は含めません。環境変数による deck/channel 指定は受理しません。

### Pedal handoff modes

The physical bindings are an explicit state machine. In the product source 1.1.12
v1.1.11 production contract,
Stage 1 requires `releaseMacro.enabled:true` and `filter-then-fade-then-stop`: F13
starts the owner-deck Filter HPF and routes one correlated `DJ_RELEASE` at the
same initial action edge, then runs HPF → ChannelFader fade (CC17) → Cue/Stop.
Local Filter, fade, Stop, and reset failures stay visible and never suppress the
already-routed Release leg. The two controls reset to HPF 64 and fader 127 only
after Stop. F14 keeps the local LoopHalf mapping and arms the
measured-response window before MIDI; true no-response alone emits the
full-profile `DJ_LOOP_FALLBACK`. F15 is deliberately inactive in Stage 1 and
sends neither MIDI nor Syndocal events.

Only an authoritative `DJ_TIMELINE_STATE` with `state:"running"`, the current
`timelineId`/`playSessionId`, `pedalOwner:"timeline"`, and the correlated Release
event changes the mode to `timeline-control`. Stage 2 F13 sends one absolute
`DJ_TIMELINE_LOOP_SET { "active": true|false, "timelineId": "...", "playSessionId": "..." }`
with the opposite of the exact current `loopActive` value; authored loops and
transition holds are both eligible. `transitionHoldActive` remains an exact
diagnostic field. Unknown state and a pending F13 loop-set do not send. F14
sends the independent active-loop-only
`DJ_TIMELINE_LOOP_HALF { "timelineId": "...", "playSessionId": "..." }`,
and F15 alone sends
`DJ_TIMELINE_BEAT_JUMP { "bars": 4, "timelineId": "...", "playSessionId": "..." }`.
The retired `-4` jump is rejected. Every Stage 2 command stamps the snapshot's
exact current `timelineId` and `playSessionId`, and Stage 2 never sends
Rekordbox MIDI.
The Web Agent is diagnostic-only for authority reconciliation. It can show
`SYNC REQUIRED` when the current Syndocal Timeline owner/session conflicts with
the current DJ candidate, but it has no local owner override or return button.
An operator return to DJ control is initiated explicitly in Syndocal, which
publishes a correlated canonical
`syndocal-dj-operator-return-<epoch>-<counter>` ID. `<epoch>` is exactly 32
lowercase ASCII hex characters and `<counter>` is canonical decimal
`1..18446744073709551615` (u64::MAX), without leading zeros; arbitrary or
noncanonical IDs are rejected. rb-output reannounces the current candidate
exactly once and admits it only after the normal `DJ_TRACK_ACTIVE` ACK. The
active epoch keeps a BigInt counter high-water across reconnects; a new epoch
requires a different authoritative Timeline `sessionId`, retires the prior
epoch permanently, and latches visibly when the bounded 64-epoch retired set
is full. This keeps ownership on one authoritative path and prevents a
browser-local fallback from diverging from Syndocal.
Disconnects, missing snapshots, invalid state broadcasts, and ACK failures keep
timeline-control fail-closed. In production, Stage 1 local MIDI remains available
only for an owner already admitted by a terminal ACTIVE ACK; the network side
effect is then marked failed or pending. A fresh candidate is never admitted by
the offline path. The explicit local-test mode instead reports
`not-applicable/local-only` and has no Syndocal side effect.
See [`SYNDOCAL_PEDAL_HANDOFF.md`](SYNDOCAL_PEDAL_HANDOFF.md) for the handoff
contract and the v1.1.11 Learn mapping. The CustomMIDI1 CSV contains Filter CC16
(`B010`/`B110`), ChannelFader CC17 (`B011`/`B111`), Cue/Stop, and LoopHalf.

配布時は `@julusian/midi` と `uiohook-napi` をoptionalDependenciesとして解決し、
Windows native prebuildをpkgのassetsに含めます。機器やnative moduleがない環境でも
本体は起動継続します。strict v3 envelopeの形状はpeer contractに固定していますが、
実際のSyndocal接続・認証・MIDI機器の受入れは対象環境で別途確認が必要です。
環境変数の導線と既定値は [`.env.example`](.env.example) にまとめています。

---

## Prerequisites (前提環境)

* **OS**: Windows 11 (x64)
* **Software**: Rekordbox 7.2.13、7.2.14、7.2.18（それ以外はシグネチャの再調査が必要な場合があります）
* **Source Build Tools**: machine-installed Git for Windows、Node.js、Python 3、および `g++` (TDM-GCC/MSYS2) または Visual Studio C++ Build Tools

※ *注意*: プロセス注入型のフックエンジンのため、アンチウイルスソフト（Windows Defender等）にて検知・ブロックされる場合や、管理者権限が必要になる場合があります。環境に応じた例外設定および自己責任でのご利用をお願いいたします。

---

## Setup & Launch

### 1. 初回セットアップ

リポジトリをクローン後、NodeパッケージとPythonライブラリをインストールします。

Source checkoutでは、固定したMinHook commitの取得・検証にmachine-installed Git for
Windowsが必要です。Git導入後に開いた通常のターミナルでは、`where.exe git`の先頭が通常
`C:\Program Files\Git\cmd\git.exe`を指します。導入前から開いているプロセスでPATHが古い
場合も、buildはOS／HKLMから導出した同じtrusted rootのcanonical `cmd\git.exe`だけを探索
します。alias、shim、信頼済みroot外のportable Gitは拒否します。インストール済みreleaseの
公演起動にはGit、Node.js、Python、C++ Build Toolsは不要です。

```powershell
npm ci
python -m venv .venv
.venv\Scripts\pip install -r python\requirements.txt
```

`npm ci` はロックされた開発依存 `@yao-pkg/pkg@6.22.0` もインストールします。
release build では追加の `npm install` や `--no-save` は使用しません。

#### C++コンパイラの導入
DLLのビルドには `g++` または Visual Studio C++ Build Tools を使用します。`g++` の候補は以下の通りです。
- [TDM-GCC](https://jmeubank.github.io/tdm-gcc/)
- [MSYS2](https://www.msys2.org/) (mingw-w64)

### 2. 将来の検証済みproduct source 1.1.12インストール済みリリースの起動

この経路は、product source 1.1.12のtag・identity-bound artifact・対象DJ PCでの検証が完了した後だけ
公演運用に使用します。公開済みv1.1.3は使用禁止であり、product source 1.1.12未公開期間に既存shortcutを
起動して代用してはいけません。検証済みproduct source 1.1.12をインストールした後は、Rekordboxを先に
起動し、スタートメニューまたはデスクトップの
`DJLinkForPCDJ` ショートカットを実行してください。これはインストール先の
`start-rb.bat` を起動し、署名済みmanifestと全payloadを検証してからserverとHookを
開始します。

### 3. product source 1.1.12未公開期間の公演前source acceptance（現在の暫定正規経路）

検証済みproduct source 1.1.12 installerが存在するまで、対象DJ PCではcheckout外の上記JSON構成を
明示して**唯一の**source launcherを実行します。`start-all.bat`は`.env`やSetup画面の
選択を保存・読込しません。構成またはtokenを変えた場合は、同じPowerShellで環境を設定
し直して同じランチャーを再実行してください。退役済み`REKORDBOX_EXE_PATH`の
Process/User/Machine確認とfail-closeは、ここに重複した手順を置かず、必ず
`start-all.bat`自身が行います。production launcherは**引数なし**で実行します。
初回の外部JSON作成だけはexact小文字`--init-config`、既存v1.1.10 sourceの一回限りの
移行だけはexact小文字`--upgrade-config`、production preflightだけはexact小文字
`--preflight-only`を使えます。いずれもbuildや公演側processを起動せず、それ以外または
複合した引数は一切受理されません。
現在の公演にinstallerやpackaged exeは不要です。既存の厳密なv1.1.10外部JSONは、上記の
one-way `--upgrade-config` で一度だけv1.1.11へ移行します。

```powershell
.\start-all.bat --init-config
# Replace only <SYNDOCAL_ONE_TIME_TOKEN> in the created external file.
$env:DJ_AGENT_CONFIG_PATH = "C:\SyndocalShow\dj-agent-v1.1.11.json"
.\start-all.bat --preflight-only
.\start-all.bat
```

起動後に`http://localhost:8787`のSetup/statusで、Agent enabled、token configured、
adapter `syndocal-envelope-v3`、host `192.168.50.1`、local NIC `192.168.50.2`、MIDI
`CustomMIDI1`と現在列挙されたexact portを確認します。この画面の`token configured`や
WebSocketの`connected`だけではHELLO/auth成功を証明しません。次にSyndocal側のpeerで
HELLO/authとstate sync、generation、heartbeatを確認し、最後に物理イベントの相関ACKを
受入れ証跡にします。一項目でも不一致なら公演同期を開始しません。

このsource経路は現在の対象DJ PCでのpre-release acceptance例外です。一般配布の
installer完成を主張するものではありません。

#### v1.1.11 production any-deck operator proof

Before recording a show cue, import
`server/public/setup/CustomMIDI1-Syndocal-v1.1.11.csv` and confirm the Setup/status
view reports the admitted owner deck/session. Start one exactly mapped track on a
non-MASTER deck: it must produce one `DJ_TRACK_ACTIVE`, and a MASTER change must
neither retrigger nor replace that owner. Later `DJ_TRACK_SYNC`, measured
`DJ_LOOP_STATE`/`DJ_LOOP_FALLBACK`, and `DJ_RELEASE` must stay correlated to that
same admitted deck, deckId, and playSessionId. An unmapped, foreign, stale, or
conflicting candidate must fail closed without mutating the owner. These remain
hardware acceptance observations; this document does not claim that acceptance.

#### Token-free HW-4 status evidence

With the source server already running on the controlled DJ PC, capture one
bounded, read-only status snapshot without starting or stopping any process:

```powershell
node scripts/dj-agent-hw4-evidence.js > hw4-evidence.json
node scripts/dj-agent-hw4-evidence.js --watch 12 --interval-ms 1000 > hw4-evidence-watch.json
```

The recorder performs only `GET` requests to the literal-loopback
`/api/dj-agent/status` and the localhost-only `/api/dj-agent/setup`. Its allowlisted JSON omits setup
configuration, track text, messages, and credential material; a
secret-shaped key or value fails closed before output. `--watch` is bounded to
2..120 samples; without `--watch` exactly one sample is captured, and each
sample has an independent wall-clock deadline. A nonzero exit produces no evidence JSON. This is status
evidence only and does not prove physical Rekordbox, MIDI, pedal, LAN, or
Syndocal acceptance.

#### Source launcherの動作

プロジェクトルートにある**唯一のsource launcher**を実行してください。引数は付けません。
初回のtoken-free外部JSON作成だけはexact小文字の`--init-config`、preflight成功のみの確認は
exact小文字の`--preflight-only`です。その他または複合した引数は何より先に拒否されます。
production起動はまず
`REKORDBOX_EXE_PATH`のProcess/User/Machine preflightをfail-closeで行い、「DLLの再ビルドと
provenance検証」→「このcheckoutが所有するWebサーバーを現在の環境変数で再起動」→
「Rekordboxへのインジェクト」→「ブラウザ起動」までを処理します。対応版のRekordboxが
起動していなければ、インストール済みの7.2.18、7.2.14、7.2.13の順で自動起動します。
既存DLLの存在だけでは成功扱いにしません。以前にsource Hookを注入したRekordboxが
起動中の場合はDLLを保持しているため、いったんRekordboxを終了してから実行してください。

```powershell
.\start-all.bat
```

WebサーバーはRekordboxプロセスを定期監視せず、フックの自動再注入も行いません。
Rekordboxを再起動した場合は、`npm run inject:hook` をもう一度実行してください。

### 4. 個別の手動実行コマンド（開発専用）
もし各処理を単独で実行したい場合は以下のコマンドを使用します。
これは開発時の分解診断専用で、2026-08-30公演のsource acceptance導線ではありません。
公演では上記の`start-all.bat`だけを使用し、この節のコマンドへ置き換えないでください。

```powershell
# 1. 注入用DLLのビルド
npm run build:hook

# 2. サーバーの起動 (既定: LAN bind / 8787)
npm start

# 3. 起動中のRekordboxへDLLの注入
npm run inject:hook
```
HTTP診断/UIサーバーの既定 bind は、read-only APIを従来どおりIPv4 LANから利用
できるよう `0.0.0.0` です。これはNodeの暗黙既定ではなく、製品の既知の
IPv4-only既定値として明示されています。ローカル専用のDJ/Syndocal構成では、
`$env:RB_OUTPUT_HOST='127.0.0.1'; npm start` を推奨します。DJ用PCの特定NICだけに
bindする場合は、`RB_OUTPUT_HOST` にIPv4/IPv6リテラルを指定してください
（例: `$env:RB_OUTPUT_HOST='192.168.50.2'; npm start`）。IPv6は`::1`のようなraw
literalと`[::1]`のようなURL形式を受け付け、bind前にraw literalへ正規化します。
未設定または空欄だけが既定の`0.0.0.0`を選択します。ホスト名、括弧不整合、typoを
含む非空の不正値は、意図せず全IPv4インターフェイスへ公開しないよう起動時に
fail-closedで拒否します。全インターフェイス公開が不要な場合は、必ず特定NICまたは
`127.0.0.1`（IPv6 local-onlyなら`::1`）を明示してください。
※`REKORDBOX_EXE_PATH`は退役済みです。source acceptanceでは唯一の`start-all.bat`が
Process/User/Machineをfail-closeで確認します。`--launch-path`は任意パス
overrideではなく、列挙された対応版（7.2.13／7.2.14／7.2.18）のcanonical installと
完全一致する`rekordbox.exe`だけを受理します。`--launch-installed`は実行中の対応版を
優先し、なければ対応するインストール済み最新版だけを選びます。未対応版または別install
だけが実行中なら注入せずfail-closeします。自動起動した場合は固定の
`--launch-settle-seconds 15`で今回の`Popen` PIDだけを15秒間監視し、canonical path/name/
create-timeの変化・終了・照会不能を検出したら注入せずfail-closeします。既存の対応版は
このsettleを待たずに注入します。Webサーバー単体からは自動実行されません。
ランチャーから別プロセスへ引き継がれる環境では、必要な場合だけ`--handoff-seconds 90`を
追加してください。

---

## 配布用インストーラーのビルド

GitHub にバージョンタグを push すると CI が自動でインストーラーとZIPをビルドし、Releases に添付します。タグは必ずannotated tagで作成してください（lightweight tagはpreflightが拒否します）。

```powershell
git tag -a v1.x.x -m "release v1.x.x"
git push origin v1.x.x
```

ローカルでビルドしたい場合は `npm run build:dist` を実行します。ZIPは常に生成され、
Inno Setup 6がある環境ではインストーラーも併せて生成されます。`server.exe` は
`npm ci` によりローカルへ固定インストールされた `@yao-pkg/pkg@6.22.0`
（`node_modules\.bin`）でのみ生成されます。

---

## API & Integration

Nodeサーバーからは以下のエンドポイントを通じ、他のシステム（OBS連携等）からでもステータスや現在の状態を取得可能です。

- `GET /api/health` - サーバー監視。読み取り専用のbuild identity
  (`build.version`、`build.gitCommit`、`build.sourceFingerprint`、`build.generatedAt`) と、
  明示的な`build.provenance`オブジェクト(`status`/`identityHash`/`exeSha256`/
  `measuredExeSha256`/`commitmentVerified`/`releaseTag`/`commit`/`tree`/
  `packageLockHash`/`wireContracts`/`tools`等)を含みます。
  パッケージ版(server.exe)では (1) ビルド時にexe内へコンパイルされたリリース
  コミットメントと同一ディレクトリの`build-identity.json`(identity部分)の一致、および
  (2) 実行中server.exe自体の実測SHA-256とsidecar `executableBinding.exeSha256` の一致を
  起動時に検証し、不成立なら起動前に異常終了します。旧リリースsidecarの再利用や
  別exeへの差し替えはfail-closedです。ランタイム環境変数
  `RB_OUTPUT_GIT_COMMIT`/`RB_OUTPUT_SOURCE_FINGERPRINT`は開発モードでのみ使われ、
  パッケージ版のprovenanceを偽造できません。
  設定パスやcredentialの有無は決して含みません。
- `GET /api/status` - RekordboxならびにHookエンジンの接続状況(同じ`build`
  identityを含む)
- `GET /api/now-playing` - 全デッキの状態（JSON）
- `GET /api/loops` - デッキごとのループ状態（JSON）
- `GET /api/stream` - 状態更新と `loop_state` イベントのSSEストリーム

### リリースprovenanceの検証 (QA/運用者向け)

`npm run build:dist` は fail-closed な手順で実行されます:
preflight(汚れた/未追跡ツリー・短いSHA・HEAD/注釈付きタグ不一致・
package.json/package-lock.json/installer.iss のバージョン不整合を拒否) →
`dist\build-identity.json`(core identity)と `server\embedded-commitment.js`
(exeにコンパイルされるコミットメント。生成ソースはgitignoreされ、
`server/buildIdentity.js` のリテラルrequireと pkg.scripts の
`server/**/*.js` グロブの二重機構で必ずexeに同梱される) を生成 →
pkgでserver.exeをパッケージ (コミットメントを同梱) →
`scripts/bind-executable.js` が実測exeハッシュをsidecarに
追記 → `dist\install-manifest.json` 生成 (全ペイロードのSHA-256) → ZIPと
インストーラーを作成 → 外部 `dist\release-manifest.json`
(両アーティファクトのハッシュとinstall-manifestハッシュを束ねる。自己ハッシュは
含まないため再帰なし)。

インストール済みツリーの検証は2段階です:

```
# 1) フル検証（推奨・システムNode不要。exe内蔵コミットメントも検証）
"C:\Program Files\DJLinkForPCDJ\server.exe" --verify-install

# 2) マニフェスト層の外部検証（システムNodeがある場合）
node scripts\verify-install.js --install-dir "C:\Program Files\DJLinkForPCDJ"
```

`start-rb.bat` は通常起動の前に必ず 1) を実行し、失敗時はサーバーを起動しません。
正準フォーマット、identityハッシュ、全ペイロードのハッシュ、実行中exeとの束縛を
検証し、欠落・改変ファイルは非ゼロで拒否します。

**境界の明示**: マニフェスト束縛は決定論的なハッシュチェーンであり、完全な再現
ビルドやデジタル署名（Authenticode等）の保証ではありません。攻撃者がファイル全体を
再生成できる場合はhash-onlyの束縛では防げず、リリース鍵による署名やHSM管理が
今後の課題です。

詳細なイベント契約は [API.md](API.md) を参照してください。既存の `state`
Socket.IOイベントは後方互換のまま `loopStates` を含み、ループ更新時には
`loop_state`イベントも発行されます。

---

## Known Issues & Troubleshooting

- **シグネチャの不一致**: Rekordbox のアップデートが行われた場合、関数のメモリアドレスを検索・フックするための「シグネチャ」が無効になる可能性があります。その場合は `hookdll.cpp` のシグネチャ文字列の再調査および更新が必要です。
- **補完機能**: 現在のserver buildでは `PYTHON_BRIDGE_ENABLED=false` がコード固定されており、環境変数だけではDB補完を有効化できません。再度有効化する場合はコード変更と実行環境での再検証が必要です。
- **未マップイベント**: 新しいRekordbox環境において、DLLから未知のイベント名が到着した場合は、UIのDEBUG LOGセクションに `Unmapped hook event` として出力されます。
