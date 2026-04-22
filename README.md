# Rekordbox DJ Link for PCDJ

Rekordbox 7.2.13 と Pioneer DJコントローラー（FLXシリーズ等）環境における、**低遅延Now PlayingおよびBPMリアルタイム配信システム**です。

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
* **柔軟かつリッチなUI (ブラウザ配信)**
  * ダーク/ライトテーマ対応、任意のアクセントカラー設定。
  * **Sortable.js** を利用した、表示項目の自由なドラッグ＆ドロップ並び替え機能。
  * 必要な項目（Album, Genre, Key, Label, Time, Track BPM）の表示ON/OFF切り替え。
  * スマホ、タブレット、PCのどのサイズにでも対応するレスポンシブデザイン。

---

## Prerequisites (前提環境)

* **OS**: Windows 11 (x64)
* **Software**: Rekordbox 7.2.13 (バージョンが異なると動作しない、またはシグネチャの更新が必要です)
* **Build Tools**: Node.js, Python 3, および `g++` 実行環境 (TDM-GCC, MSYS2 など)

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

#### g++ (C++コンパイラ) の導入
DLLのビルドに `g++` が必須です。コマンドプロンプトで `g++ --version` と入力してエラーが出る場合、以下のいずれかから導入し、環境変数のPATHを通してください。
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

---

## 配布用インストーラーのビルド

[Inno Setup 6](https://jrsoftware.org/isdl.php) をインストール後、以下を実行すると `dist\rb-output-setup.exe` が生成されます。

```powershell
npm run build:dist
```

インストーラーは Node.js・Python・g++ を一切必要とせず、ダブルクリックだけでセットアップが完了します。

---

## API & Integration

Nodeサーバーからは以下のエンドポイントを通じ、他のシステム（OBS連携等）からでもステータスや現在の状態を取得可能です。

- `GET /api/health` - サーバー監視
- `GET /api/status` - RekordboxならびにHookエンジンの接続状況
- `GET /api/now-playing` - 全デッキの状態（JSON）

---

## Known Issues & Troubleshooting

- **シグネチャの不一致**: Rekordbox のアップデートが行われた場合、関数のメモリアドレスを検索・フックするための「シグネチャ」が無効になる可能性があります。その場合は `hookdll.cpp` のシグネチャ文字列の再調査および更新が必要です。
- **補完機能**: `PYTHON_BRIDGE_ENABLED` により、メタデータがHook内で取りきれなかったケースでもデータベース解析等により情報の補完が行われます（既定で有効）。
- **未マップイベント**: 新しいRekordbox環境において、DLLから未知のイベント名が到着した場合は、UIのDEBUG LOGセクションに `Unmapped hook event` として出力されます。
