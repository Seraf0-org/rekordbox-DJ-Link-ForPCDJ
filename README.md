# Rekordbox DJ Link for PCDJ

Rekordbox 7.2.13、7.2.14、7.2.18 と Pioneer DJコントローラー（FLXシリーズ等）環境における、**低遅延Now PlayingおよびBPMリアルタイム配信システム**です。

Rekordbox のプロセスに専用のDLL (`rb_hook.dll`) を注入し、内部関数を直接フックすることで、ポーリングファイル監視では実現できない0秒遅延の楽曲状態の取得とWebサーバーでの統合表示を行います。

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

Webサーバーは `C:\Program Files\rekordbox` 配下から最新のインストール版を自動選択します。別の実行ファイルを使う場合は `.env` の `REKORDBOX_EXE_PATH` で明示できます。

---

## 配布用インストーラーのビルド

GitHub にバージョンタグを push すると CI が自動でインストーラーをビルドし、Releases に添付します。

```powershell
git tag v1.x.x
git push origin v1.x.x
```

ローカルでビルドしたい場合は `npm run build:dist` を実行します。Inno Setup がなければ ZIP で出力されます。

---

## API & Integration

Nodeサーバーからは以下のエンドポイントを通じ、他のシステム（OBS連携等）からでもステータスや現在の状態を取得可能です。

- `GET /api/health` - サーバー監視
- `GET /api/status` - RekordboxならびにHookエンジンの接続状況
- `GET /api/now-playing` - 全デッキの状態（JSON）
- `GET /api/loops` - デッキごとのループ状態（JSON）
- `GET /api/stream` - 状態更新と `loop_state` イベントのSSEストリーム

詳細なイベント契約は [API.md](API.md) を参照してください。既存の `state`
Socket.IOイベントは後方互換のまま `loopStates` を含み、ループ更新時には
`loop_state`イベントも発行されます。

---

## Known Issues & Troubleshooting

- **シグネチャの不一致**: Rekordbox のアップデートが行われた場合、関数のメモリアドレスを検索・フックするための「シグネチャ」が無効になる可能性があります。その場合は `hookdll.cpp` のシグネチャ文字列の再調査および更新が必要です。
- **補完機能**: `PYTHON_BRIDGE_ENABLED` により、メタデータがHook内で取りきれなかったケースでもデータベース解析等により情報の補完が行われます（既定で有効）。
- **未マップイベント**: 新しいRekordbox環境において、DLLから未知のイベント名が到着した場合は、UIのDEBUG LOGセクションに `Unmapped hook event` として出力されます。
