# Rekordbox DJ Link for PCDJ

Rekordbox 7.2.13、7.2.14、7.2.18 と Pioneer DJコントローラー（FLXシリーズ等）環境における、**低遅延Now PlayingおよびBPMリアルタイム配信システム**です。

Rekordbox のプロセスに専用のDLL (`rb_hook.dll`) を注入し、内部関数を直接フックすることで、ポーリングファイル監視では実現できない0秒遅延の楽曲状態の取得とWebサーバーでの統合表示を行います。

## v1.1.3 リリースノート

Syndocal公演同期を`syndocal-envelope-v2`へclean breakし、配布物の真正性検証
（provenance）も大幅に強化しました。

* **strict show-sync v2**: 旧flat/v1 adapterを退役し、exact master deck、
  playSessionId、track identity、position、BPM、revision、freshnessが揃った時だけ
  ACTIVEを送信します。継続TRACK_SYNC、実測loop 8/4/2、相関済みRELEASE、
  reconnect時の同一eventId/playSession再送をstrict v2 envelopeで固定しました。
  欠落、null、非有限、古いsample、reorder、旧wireは明示的にfail-closedします。
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

### v1.1.3 first-run Setup / live checkpoint (2026-08-25)

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
`ChannelFader=B011/B111`、`Cue=9025/9125`、`LoopHalf=9024/9124`です。

MIDI outputは、列挙された同一optionの非空device nameとsafe integer portが一致した
場合だけ既存選択を反映します。`null`/空/boolean/数値文字列をportとしてseedせず、
port 0を暗黙選択しません。adapterは初回必ず未選択です。device/portは既存設定が
あり、列挙結果のname+portへ完全一致する場合だけ反映し、それ以外は未選択にします。
operatorがこのページで明示選択した後だけpreviewへ反映します。同一ページのrefreshでは
触った選択を維持しますが、name+portが列挙結果から消えた場合はplaceholderへ戻して
fail-closedにします。出荷・現行productionの唯一のadapterは
`syndocal-envelope-v2`です。未設定時もv2になり、旧flat `generic-json`と
`syndocal-envelope-v1`は互換選択肢として残さず明示的に拒否します。

2026-08-25のDJ PC live preflightは受入れ完了を意味しません。

| surface | live fact |
| --- | --- |
| peer | 旧buildのpeerはSetup endpointが404 (`peer old build 404`) |
| local Agent / MIDI / pedal / hook | いずれもOK |
| Syndocal | 現在disabled。send-failed境界も観測済みで、接続成功とは扱わない |
| physical acceptance | **0/12**。ハードウェア受入れは未実施 |

MinHook pinおよび`build-dist`経路の最終レビューはpendingです。このcheckpointでは
それらの完了や、上表のlive factsからのhardware acceptanceを断言しません。

## v1.1.1 リリースノート

Rekordbox 7.2.18での実機検証を進め、Web表示とHook連携を安定化しました。

* クロスフェーダーとDeck 1/2のチャンネルフェーダー量をRekordbox内部から取得し、Web UIとAPIへリアルタイム配信。
* Track BPMの一時的な欠落、再生時間の遅延、ページ再読み込みが必要になる問題を修正。
* Time欄へ波形付きシークバーを追加し、ループ区間の設定と実際のループ動作を区別。
* Warningsの折りたたみ、全体幅レイアウト、カスタムスクロールバー、リポジトリ・クレジット付きフッターを追加。
* WebサーバーによるRekordboxの定期監視、自動起動、自動再注入を廃止。Rekordbox再起動後の注入は明示操作のみ。
* 当時の旧Syndocal wireとbuild identityを追加（現在はstrict v2へclean break済み）。
* npmとPython依存関係の既知脆弱性監査は0件。Nodeテスト69件、Hook DLLビルド、Rekordbox 7.2.18実機接続を確認済み。

## v1.1.0 リリースノート

既存のNow Playing本体との後方互換を保ったまま、Rekordbox連携と任意の
DJ Agent拡張を強化しました。

* Rekordboxの最新インストール検出と、Loop状態・未知イベントの診断経路を追加。
* DJ Agentは既定OFFのoptional拡張として統合。未接続のSyndocal、MIDI、または
  global hotkey adapterがあっても本体の起動を妨げません。
* master deckに応じたdeck-aware MIDI channel routingを追加。
* ペダルを2段階制御化。Stage 1はF13の設定可能なHP→ChannelFader fade→Cue/Stop
  （`filter-then-fade`、従来互換のparallelも選択可）、
  F14のLoopHalf、F15のinactive。authoritative timelineがrunningになるStage 2では、
  F13/F15が±4 bars、F14がabsolute loop toggleとなり、Rekordbox MIDIは送信しません。
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

## DJ Agent 拡張 (既定OFF)

SyndocalのShow Control、ペダル、rekordbox MIDI出力は、一般利用者向けの
Now Playing本体とは分離された任意拡張です。既定では無効で、次のいずれかを
明示した場合だけ、既存Nodeサーバー内で起動します。

~~~powershell
$env:DJ_AGENT_ENABLED = "true"
npm start
~~~

または `DJ_AGENT_CONFIG_PATH` に、リポジトリ外のJSON設定ファイルを指定します。Nodeは
`.env`を自動ロードしないため、`.env.example`は値の一覧を示すテンプレートです。
トークンは`SYNDOCAL_TOKEN`などのプロセス環境、または明示した外部設定ファイルから
読み込みます。Syndocalを有効にする場合は32〜256 UTF-8 bytesで、Unicode control文字や
空白を含まないtokenが必須です。リポジトリへ保存したりログ・ステータスへ出力したり
しません。wire文字列はUnicode scalarとして検証し、KDMXの`char::is_control`相当の
Ccと256 UTF-8 bytes超を拒否します。Cf/ZWJ、U+2028/U+2029はKDMX互換のため許可し、
unpaired surrogateは拒否します。出荷・現行productionの唯一のadapterは
`syndocal-envelope-v2`、接続先pathは`/dj-link`、heartbeatは5000msです。接続後は
`DJ_AGENT_HELLO` → 権威snapshot(`DJ_STATE_SYNC`) →
`DJ_TIMELINE_STATE_REQUEST`/timeline actionの順序が必須で、snapshot確定前の
timeline操作はfail-closedです(SnapshotRequired)。adapterは
`SYNDOCAL_WS_ADAPTER`またはfirst-run Setup cardで明示できます。選択可能値は
`syndocal-envelope-v2`だけです。旧flat/v1名、未知名、曖昧な別名はfail-closedで、
変換・fallback・legacy adapterはありません。

~~~json
{
  "enabled": true,
  "syndocal": {
    "host": "192.168.10.20",
    "port": 9100,
    "path": "/dj-link",
    "nic": "192.168.10.10",
    "adapter": "syndocal-envelope-v2",
    "heartbeatMs": 5000
  },
  "pedal": {
    "bindings": { "release": "F13", "loopHalf": "F14", "filterClose": "F15" }
  },
  "midi": {
    "device": "Virtual MIDI",
    "mappings": {
      "loopHalf": { "channel": 1, "messageType": "noteOn", "note": 36, "value": 127 },
      "stop": { "channel": 1, "messageType": "noteOn", "note": 37, "value": 127 },
      "filter": { "channel": 1, "messageType": "controlChange", "cc": 16 },
      "releaseFade": { "channel": 1, "messageType": "controlChange", "cc": 17 }
    },
    "deckChannels": { "1": 1, "2": 2 },
    "filter": { "startValue": 127, "endValue": 0, "durationMs": 2000, "updateIntervalMs": 50 },
    "releaseFade": {
      "enabled": true, "mapping": "releaseFade", "target": "deck",
      "startValue": 127, "endValue": 0, "durationMs": 1000,
      "updateIntervalMs": 50, "resetAfterStop": true, "resetValue": 127
    },
    "releaseMacro": {
      "enabled": false,
      "sequence": "filter-then-fade",
      "filter": { "startValue": 64, "endValue": 127, "durationMs": 1000, "updateIntervalMs": 50, "resetValue": 64 },
      "resetAfterStop": true
    }
  }
}
~~~

`releaseMacro.enabled` はphysical acceptanceが完了するまで必ずfalseのままにします。
上のramp定義は受入れ後にoperatorが明示的に有効化する場合の契約例であり、
first-run Setupのpreviewでも常にfalseへ固定されます。

DJ_AGENT_ENABLED未設定時はoptionalなWebSocket/MIDI/global-hotkey依存を読み込まず、
SyndocalやMIDI機器が未接続でも既存のHook UDP、Web UI、Socket.IO、HTTP APIは
継続します。拡張を有効にした場合も、/api/dj-agent/actions/loop-half、
/api/dj-agent/actions/filter-close、/api/dj-agent/actions/release、
/api/dj-agent/actions/track-active は物理ペダルと同じAction経路を使う診断用
エンドポイントです。Windows global hotkey用adapterとMIDI transportは実行時に
optional requireされ、未導入なら機能を無効表示して本体を停止させません。
読み取りAPIはLANから利用できますが、/api/dj-agent/actions/* のPOST action診断は
**恒久的にIPv4/IPv6 loopback限定**であり、DJ PC上のlocalhostからだけ到達できます。
判定は実際のTCP peerアドレスに基づき、Host/Origin/X-Forwarded-*や設定では
peerを偽装できません。旧env `DJ_AGENT_ALLOW_REMOTE_ACTIONS` とconfig-fileの
`allowRemoteActions` は非推奨です。trueを設定しても権限は一切開かず、起動時に
固定の（呼び出し値を含まない）セキュリティ警告を1件出力します。
物理ペダルとglobal hotkeyはDJ PCローカルで動作し、FOH側のShow Controlは
トークン認証済みの `/dj-link` WebSocket経由で行います。この変更で、LAN向けの
read-only GET APIや既存のSocket.IOイベントが認証付きになったわけではありません
（両者は従来どおり無認証のままです）。物理wire event（DJ_MASTER_CHANGED、
DJ_MASTER_TRACK_ACTIVE、DJ_LOOP_STATE、DJ_RELEASE、DJ_TIMELINE_BEAT_JUMP、
DJ_TIMELINE_LOOP_SET）はすべてACK必須で、送信直後を成功扱いにせず、
pending/acknowledged/rejected/timed-out/send-failedを `/api/dj-agent/status` とUIに
反映します。`accepted`/`duplicate`だけが成功、`no_mapping`/`rejected`はterminal failure、
`busy`だけが同じ`eventId`・`sequence`・flat shape・socket generationのまま短い指数backoffで
有限回再送されます。型不足・未知outcome・`ok`不整合のACKはprotocol failureとして無視し、
ACK timeoutまでpendingを維持します。HELLO/heartbeat/State Sync/timeline requestは
physical ID capから分離したcontrol ID/sequenceを使い、再接続時に旧physical eventを再送しません。
timeline state requestのcaller-supplied eventIdは受け付けず、control IDはプロセス内で生成します。

State Sync providerがthrow、null、undefined、またはKDMX flat validationに失敗した場合は、
空snapshotへ置換せず、state-sync-error/send-failedとstatusへ記録してState Syncもtimeline
requestも送信しません。valid snapshotを送信できた場合だけtimeline requestを続行します。
physical caller eventIdはプロセス中再利用不可で、既定262144件のbounded registryが上限到達時に
fail-closed latchします。sequenceはcontrolを含むsession wire high-waterより厳密に大きい
safe integerだけを受け付け、rollback/fraction/overflowは送信・予約しません。

Syndocalを無効にしたローカル専用構成では、従来どおりMIDI操作を単独で
継続します。Syndocal handoffを有効にした構成でも、初回接続中・再接続中・
切断中、および再接続後に権威`DJ_TIMELINE_STATE`を受信するまで、Stage 1の
ローカルRekordbox MIDI操作は継続し、失敗するのはネットワーク送信だけです。
`timeline-control`のStage 2操作は、接続済みかつsnapshot確定時だけ送信します。
`idle`/`stopped`/`ended`/`reset`のsnapshotを受信するとStage 1へ戻ります。

MIDIをRekordboxのmaster deckごとに分ける場合は、`midi.deckChannels` に
`{"1":1,"2":2}` のようなdeck番号→MIDI channel（1〜16）を指定します。
loop-half、release、filter rampの全CC送信に適用され、未指定のdeckは各mappingの
`channel`へfallbackします。実行中のaction resultには `targetDeck` と
`targetChannel` が含まれます。KDMX flat wire framesはstrict fieldsだけを送信し、
この診断情報は含めません。環境変数では
`MIDI_DECK_CHANNELS` に同じJSONを指定できます。

### Pedal handoff modes

The physical bindings are an explicit state machine. In Stage 1, F13 is an
optional release macro. Its default `sequence:"parallel"` keeps the existing
behavior: Filter HP 64→127 and the master deck's `ChannelFader` 127→0 run in
parallel for one second. With `sequence:"filter-then-fade"`, the Filter ramp
must complete successfully before the ChannelFader ramp sends its first MIDI
message. Only after both ramps succeed does the agent send the deck Cue/Stop,
restore Filter 64 and Fader 127, send `DJ_RELEASE`, and enter
`handoff-pending`. Filter or fade failure never sends Stop/Release; a fade
failure attempts a safe Filter reset and reports the result. If the macro is
not configured, the legacy direct stop/release path remains available. F14
keeps the local LoopHalf mapping. F15 is deliberately inactive in Stage 1 and
sends neither MIDI nor Syndocal events.

Only an authoritative `DJ_TIMELINE_STATE` with `state:"running"` changes the
mode to `timeline-control`. Stage 2 maps F13/F15 to
`DJ_TIMELINE_BEAT_JUMP` with `bars:-4/+4`, and F14 to the absolute
`DJ_TIMELINE_LOOP_SET {"active":boolean}`. Stage 2 never sends Rekordbox MIDI.
Disconnects, missing snapshots, invalid state broadcasts, and ACK failures keep
timeline-control fail-closed; Stage 1 local MIDI remains available while only
the network side effect is marked failed or pending.
See [`SYNDOCAL_PEDAL_HANDOFF.md`](SYNDOCAL_PEDAL_HANDOFF.md) for the handoff
contract and a direct Learn mapping example. The standard Rekordbox CSV uses
the deck-specific `ChannelFader` control (for example `ChannelFader,,KnobSlider,,B011,B111,...`);
the CustomMIDI1 example uses Filter CC16 (`B010`) and release-fade CC17
(`B011`/`B111` for Deck 1/2), with the actual deck channel selected by
`deckChannels`.

配布時は `@julusian/midi` と `uiohook-napi` をoptionalDependenciesとして解決し、
Windows native prebuildをpkgのassetsに含めます。機器やnative moduleがない環境でも
本体は起動継続します。strict v2 envelopeの形状はpeer contractに固定していますが、
実際のSyndocal接続・認証・MIDI機器の受入れは対象環境で別途確認が必要です。
環境変数の導線と既定値は [`.env.example`](.env.example) にまとめています。

---

## Prerequisites (前提環境)

* **OS**: Windows 11 (x64)
* **Software**: Rekordbox 7.2.13、7.2.14、7.2.18（それ以外はシグネチャの再調査が必要な場合があります）
* **Build Tools**: Node.js、Python 3、および `g++` (TDM-GCC/MSYS2) または Visual Studio C++ Build Tools

※ *注意*: プロセス注入型のフックエンジンのため、アンチウイルスソフト（Windows Defender等）にて検知・ブロックされる場合や、管理者権限が必要になる場合があります。環境に応じた例外設定および自己責任でのご利用をお願いいたします。

---

## Setup & Launch

### 1. 初回セットアップ

リポジトリをクローン後、NodeパッケージとPythonライブラリをインストールします。

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

### 2. ワンクリック起動 (おすすめ)

先にRekordboxを起動してから、プロジェクトルートにあるバッチファイルを実行してください。「DLLのビルド確認」→「Webサーバー起動」→「起動中のRekordboxへのインジェクト」→「ブラウザ起動」までを処理します。

```powershell
start-all.bat
```

WebサーバーはRekordboxプロセスを定期監視せず、未起動時の自動起動やフックの自動再注入も行いません。Rekordboxを再起動した場合は、`npm run inject:hook` をもう一度実行してください。

### 個別の手動実行コマンド
もし各処理を単独で実行したい場合は以下のコマンドを使用します。

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
※インジェクターから明示的にRekordboxを起動したい場合に限り、`python scripts\inject_hook.py --launch-path "D:\path\to\rekordbox.exe"` を使用できます。通常の起動コマンドやWebサーバーからは自動実行されません。ランチャーから別プロセスへ引き継がれる環境では、必要な場合だけ `--handoff-seconds 90` を追加してください。

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
