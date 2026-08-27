# Syndocal / Pedal handoff contract

この文書は、Syndocal側と`rb-output`側を別担当で接続するための実装契約です。

## 2026-08-27 current v1.1.8 any-deck strict show-sync v3

現在の唯一のadapterは`syndocal-envelope-v3`で、全frameは
`{v:3,type,agentId,sessionId,sequence,eventId,payload}`のexact shapeです。
flat/v1/v2は退役し、設定・Setup・runtime・build identityで明示拒否します。
product source versionは`1.1.8`です。v1.1.8のinstaller、tag、public release、または
hardware acceptanceはこの文書で主張しません。current/next operator routeはtracked
`config/dj-agent-v1.1.8.example.json`と
`server/public/setup/CustomMIDI1-Syndocal-v1.1.8.csv`を使います。exact
`start-all.bat --init-config`は存在しない場合だけ
`C:\SyndocalShow\dj-agent-v1.1.8.json`を作成し、deployed historical
`C:\SyndocalShow\dj-agent-v1.1.5.json`をread/copy/overwrite/deleteしません。

v1.1.7 any-deck境界はhistorical/supersededなレビュー済み境界です。v1.1.8
controlled-source changeはその旧境界を基礎にした現在のcontrolled-source
trancheです。本書はinstaller、tag、public release、対象DJ PCへの配備、または
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

### DEPLOYED HISTORICAL / DO NOT EXECUTE — v1.1.5 controlled-source handoff

以下はv1.1.5のdeployed controlled-source handoffと当時のsoftware/hardware evidenceです。
provenanceのため保持しますが、current/next operator guidance、v1.1.8 config/CSV、または
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
現行authorityは本書冒頭のv1.1.8 any-deck/v3だけです。

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
DJ PCへ適用してはいけません。現行のlauncher/設定は本書冒頭のv1.1.8 any-deck/v3 authorityと、
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
いけません。現行authorityは本書冒頭と次節以降のv1.1.8 any-deck strict-v3だけです。
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

## CURRENT v1.1.8 / strict-v3 接続と状態同期

WebSocket接続後、クライアントは順に`DJ_AGENT_HELLO`、`DJ_STATE_SYNC`、
`DJ_TIMELINE_STATE_REQUEST`を送信します。再接続・再起動後も同じ順序で、
Syndocalは現在の権威状態を`DJ_TIMELINE_STATE`で返してください。状態が返る
まではtimeline actionを送らず、`timeline-control`中の切断は`dj-control`へ
自動復帰しません（安全側に停止します）。

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

## CURRENT v1.1.8 / Stage 1: Rekordbox操作とhandoff

v1.1.8 controlled sourceは`releaseMacro.enabled:true`かつ
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

v1.1.8 CSVはChannelFader CC17（`B011`/`B111`）を含み、strict launcherはFilter
CC16、fade CC17、enabled fade、exact duration/value/deck-channelを要求します。実機のLearn結果が異なる場合、この
controlled sourceを推測で別CCへ切り替えず、fail-closedで新しいevidence trancheを開始します。

### showEventRouterの分割境界

公演前の今回のtrancheでは`showEventRouter.js`の大規模な抽出を延期します。
authority、delivery、play-session、shutdown generation、public action emissionが同じ
経路で結合しており、deadline前の分割はNO-GOです。将来の低リスク抽出先は
`server/dj-agent/releaseMacro.js`とし、ramp/timer/local-failure/Stop-reset/generation
だけを所有します。routerはauthority、delivery、session fence、public emission、shutdownを
保持し、Stage 2 timeline-controlの意味は変更しません。

## CURRENT v1.1.8 / Stage 2: timeline control（別境界・±4は未受入）

`running`後のtimeline-controlは現行v1.1.8の別境界です。すべてACK対象で、Stage 2では
Rekordbox MIDIを一切呼びません。±4 beat-jumpを含むこのStage 2物理受入はStage 1の
Release実機証跡とは別で、現時点では未受入です。

| Pedal | outbound | payload |
| --- | --- | --- |
| F13 | `DJ_TIMELINE_BEAT_JUMP` | `{ "bars": -4, "timelineId": "...", "playSessionId": "..." }` |
| F14 | `DJ_TIMELINE_LOOP_SET` | `{ "active": true\|false, "timelineId": "...", "playSessionId": "..." }` |
| F15 | `DJ_TIMELINE_BEAT_JUMP` | `{ "bars": 4, "timelineId": "...", "playSessionId": "..." }` |

両commandのpayloadは上表のexact fieldだけからなり、`timelineId`と`playSessionId`には
権威`DJ_TIMELINE_STATE`が示す現在値をそのままstampします。encoderは未知fieldを1つでも
受け取りません。内部だけが持つ出典marker `source:"pedal"`はexact一致でのみ許容され、
wire frameへはstripされます。送信frameにlocal由来のfieldは現れません。権威
`DJ_TIMELINE_STATE`の受入は同一session内では`sessionId`+`sequence`によるstaleness fenceで
判定し、stale/equal sequenceは状態を変えずに破棄します。再接続で新しいconnection
generation/sessionIdになるとfenceは再keyingされ、旧sessionとの比較は行いません。
F14は前回の権威`loopActive`を反転した絶対値を送ります。送信中は次の
toggleを保留し、terminal outcome（rejected/timed-out/send-failed）では保留latchを直ちに
解放して破棄します。skipまたはterminal失敗したLOOP_SETは次のF14操作を妨げず、新しい
絶対値として再試行可能です。
ACK成功だけで権威状態を書き換えず、次の`DJ_TIMELINE_STATE` broadcastを
待ちます。time signatureとbar gridはSyndocal側が決定し、`bars`は音楽的な
小節数（秒数ではない）です。

## CURRENT v1.1.8 / v3 eventId・ACK・順序

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
再接続/replay待ちのnon-terminal状態です。最終deliveryは`acknowledged`、`rejected`、
`timed-out`、`send-failed`のいずれかです。UI/APIはpending・success・failureを同じ
action eventIdで表示します。

典型的な順序は次です。

1. Syndocal側ですでに対象timelineが再生中であり、DJ PCは権威の
   `DJ_TIMELINE_STATE(state:"running")` snapshotを受け取る（rb-outputがtimelineを開始しない）。
2. F13の初期edgeでowner-deck HPFを開始し、同じedgeの相関済み`DJ_RELEASE`を一度だけ送る。
3. Syndocalは`DJ_RELEASE`に対してTimeline loopをOFFにし、DJ clock ownershipを relinquish
   して現在bar位置から自然継続する。即時のstart/play/seek/jump/advance/stopは行わない。
4. 相関済み`DJ_TIMELINE_STATE`が`timeline-control`を確定した後だけ、Stage 2のF13/F14/F15を
   送信する。±4 beat-jumpは別の未受入Stage 2境界である。
5. 終演・停止・resetを`DJ_TIMELINE_STATE`でbroadcastし、`dj-control`へ戻す。

切断・ACK timeout・不正state・bar grid不一致は成功扱いにせず、warningと
last deliveryに残してください。物理機器未接続でもNode本体は継続起動し、
必要な境界だけ`unavailable`/`send-failed`になります。
