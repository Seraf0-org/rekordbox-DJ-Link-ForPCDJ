# Rekordbox DJ Link for PCDJ

Rekordbox 7.2.13、7.2.14、7.2.18 と Pioneer DJコントローラー（FLXシリーズ等）環境における、**低遅延Now PlayingおよびBPMリアルタイム配信システム**です。

Rekordbox のプロセスに専用のDLL (`rb_hook.dll`) を注入し、内部関数を直接フックすることで、ポーリングファイル監視では実現できない0秒遅延の楽曲状態の取得とWebサーバーでの統合表示を行います。

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
unpaired surrogateは拒否します。既定の接続先は
KDMX互換のflat `generic-json` adapter、`/dj-link`、heartbeat 5000msです。
adapterは`SYNDOCAL_WS_ADAPTER`で明示選択します。選択できるのは
`generic-json`(flat frame、ACK 8フィールド固定)と
`syndocal-envelope-v1`(KDMXレガシーv1 envelope wire、ACK 7フィールド固定)で、
未設定・未知名はfail-closedとなり黙ってフォールバックしません。

~~~json
{
  "enabled": true,
  "allowRemoteActions": false,
  "syndocal": {
    "host": "192.168.10.20",
    "port": 9100,
    "path": "/dj-link",
    "nic": "192.168.10.10",
    "adapter": "generic-json",
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
      "enabled": true,
      "sequence": "filter-then-fade",
      "filter": { "startValue": 64, "endValue": 127, "durationMs": 1000, "updateIntervalMs": 50, "resetValue": 64 },
      "resetAfterStop": true
    }
  }
}
~~~

DJ_AGENT_ENABLED未設定時はoptionalなWebSocket/MIDI/global-hotkey依存を読み込まず、
SyndocalやMIDI機器が未接続でも既存のHook UDP、Web UI、Socket.IO、HTTP APIは
継続します。拡張を有効にした場合も、/api/dj-agent/actions/loop-half、
/api/dj-agent/actions/filter-close、/api/dj-agent/actions/release、
/api/dj-agent/actions/track-active は物理ペダルと同じAction経路を使う診断用
エンドポイントです。Windows global hotkey用adapterとMIDI transportは実行時に
optional requireされ、未導入なら機能を無効表示して本体を停止させません。
読み取りAPIはLANから利用できますが、POST actionは既定でIPv4/IPv6 loopback
だけに限定されます。明示的に `DJ_AGENT_ALLOW_REMOTE_ACTIONS=true` を設定した
場合のみリモートactionを許可します。物理wire event（DJ_MASTER_CHANGED、
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
本体は起動継続します。flat frameの形状はKDMX strict contractに合わせていますが、
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
npm install
python -m venv .venv
.venv\Scripts\pip install -r python\requirements.txt
```

#### C++コンパイラの導入
DLLのビルドには `g++` または Visual Studio C++ Build Tools を使用します。`g++` の候補は以下の通りです。
- [TDM-GCC](https://jmeubank.github.io/tdm-gcc/)
- [MSYS2](https://www.msys2.org/) (mingw-w64)

### 2. ワンクリック起動 (おすすめ)

プロジェクトルートにあるバッチファイルを実行するだけで、「DLLのビルド確認」→「Webサーバー起動」→「Rekordboxへのインジェクト」→「ブラウザ起動」までを全て自動で処理します。

```powershell
start-all.bat
```

### 個別の手動実行コマンド
もし各処理を単独で実行したい場合は以下のコマンドを使用します。

```powershell
# 1. 注入用DLLのビルド
npm run build:hook

# 2. サーバーの起動 (localhost:8787)
npm start

# 3. 起動中のRekordboxへDLLの注入
npm run inject:hook
```
※独自のインストールパスでRekordboxを使用している場合は、`python scripts\inject_hook.py --launch-path "D:\path\to\rekordbox.exe"` のように引数指定で注入可能です。

Webサーバーは `C:\Program Files\rekordbox` 配下から最新のインストール版を自動選択します。別の実行ファイルを使う場合は、Nodeを起動する同じPowerShell/launcher processへ環境変数を設定します。

~~~powershell
$env:REKORDBOX_EXE_PATH = "D:\path\to\rekordbox.exe"
npm start
~~~

Nodeは `.env` を自動ロードしないため、`.env`へ書くだけでは反映されません。注入時に別の実行ファイルを指定する場合は、`python scripts\inject_hook.py --launch-path "D:\path\to\rekordbox.exe"` を使います。

---

## 配布用インストーラーのビルド

GitHub にバージョンタグを push すると CI が自動でインストーラーをビルドし、Releases に添付します。

```powershell
git tag v1.x.x
git push origin v1.x.x
```

ローカルでビルドしたい場合は `npm run build:dist` を実行します。Inno Setup がなければ ZIP で出力されます。
`server.exe` は `@yao-pkg/pkg@6.22.0` のWindows x64 prebuiltが取得できる
`node22-win-x64` targetで生成します（`package.json`とbuild scriptで一致）。

---

## API & Integration

Nodeサーバーからは以下のエンドポイントを通じ、他のシステム（OBS連携等）からでもステータスや現在の状態を取得可能です。

- `GET /api/health` - サーバー監視。読み取り専用のbuild identity
  (`build.version`、`build.gitCommit`、`build.sourceFingerprint`。後者2つは
  ビルド/起動時に`RB_OUTPUT_GIT_COMMIT`/`RB_OUTPUT_SOURCE_FINGERPRINT`と
  して16進7..64文字で与えた場合のみ表示)を含み、PIDのバージョン特定に使えます。
  設定パスやcredentialの有無は決して含みません。
- `GET /api/status` - RekordboxならびにHookエンジンの接続状況(同じ`build`
  identityを含む)
- `GET /api/now-playing` - 全デッキの状態（JSON）
- `GET /api/loops` - デッキごとのループ状態（JSON）
- `GET /api/stream` - 状態更新と `loop_state` イベントのSSEストリーム

詳細なイベント契約は [API.md](API.md) を参照してください。既存の `state`
Socket.IOイベントは後方互換のまま `loopStates` を含み、ループ更新時には
`loop_state`イベントも発行されます。

---

## Known Issues & Troubleshooting

- **シグネチャの不一致**: Rekordbox のアップデートが行われた場合、関数のメモリアドレスを検索・フックするための「シグネチャ」が無効になる可能性があります。その場合は `hookdll.cpp` のシグネチャ文字列の再調査および更新が必要です。
- **補完機能**: 現在のserver buildでは `PYTHON_BRIDGE_ENABLED=false` がコード固定されており、環境変数だけではDB補完を有効化できません。再度有効化する場合はコード変更と実行環境での再検証が必要です。
- **未マップイベント**: 新しいRekordbox環境において、DLLから未知のイベント名が到着した場合は、UIのDEBUG LOGセクションに `Unmapped hook event` として出力されます。
