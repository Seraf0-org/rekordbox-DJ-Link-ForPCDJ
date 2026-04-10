# rb-output (Hook Mode)

Rekordbox 7.2.13 + FLX10 向けの **フック型 now-playing/BPM 配信**です。  
Rekordbox プロセスに `rb_hook.dll` を注入し、取得したイベントを UDP で Node サーバーに渡して Web 表示します。

## 現在の構成

- **Hook (DLL注入)**: `@BPM`, `@CurrentTime`, `@TotalTime` をリアルタイム捕捉
- **Web配信**: Express + Socket.IO (`/api/now-playing`, `/api/status`)
- **表示**: iPad/PC/スマホ向けレスポンシブ UI（Now Playing + 2トラック表示 + ライト/ダーク + アクセントカラー変更）
- **補助ソース**: Python bridge（履歴ベースの補完） + ContentID即時lookup（タイトル/アーティストを即時補完）

## 前提

- Windows x64
- Rekordbox 7.2.13
- `g++` (TDM-GCC など) が PATH にあること
- 注入方式のため Defender / 権限設定の影響を受ける可能性あり（自己責任）

## セットアップ

```powershell
npm install
python -m pip install -r python\requirements.txt
```

## Hook DLL のビルド

```powershell
npm run build:hook
```

- 初回は `native\third_party\minhook` を自動取得します。
- 出力: `native\bin\rb_hook.dll`

## Rekordbox への注入

```powershell
npm run inject:hook
```

必要なら起動パスを指定:

```powershell
python scripts\inject_hook.py --launch-path "C:\Program Files\rekordbox\rekordbox 7.2.13\rekordbox.exe"
```

## サーバー起動

```powershell
npm start
```

表示:
- 同一PC: `http://localhost:8787`
- 別端末: `http://<Rekordbox-PC-IP>:8787`

## まとめて起動（ワンクリック）

リポジトリ直下の `start-all.bat` を実行すると、以下を自動で行います。

1. `rb_hook.dll` が無ければビルド
2. Web サーバー（`node server\index.js`）を起動（既に起動中ならスキップ）
3. Rekordbox へフック注入
4. `http://localhost:8787` を開く

## API

- `GET /api/health`
- `GET /api/status`
- `GET /api/now-playing`

## 既知事項

- フック側で未マッピングのイベント名は警告に表示されます。
- `PYTHON_BRIDGE_ENABLED=true`（既定）で、タイトル/アーティスト補完に使います。
- リアルタイムBPM/再生位置は Hook 優先です。
- Rekordbox アップデート時はシグネチャ更新が必要です。
