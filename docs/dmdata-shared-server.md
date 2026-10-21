# 警報・通常地震情報の共有サーバー

## 配信範囲と現在の状態

各利用者のAPIキーによる直接受信は残します。共有側は `eew.warning` の `VXSE43` と `telegram.earthquake` の `VXSE52` / `VXSE53` のみです。予報の `eew.forecast` / `VXSE44` / `VXSE45`、リアルタイム震度電文、訓練・試験報は共有しません。津波・長周期地震動等はこの初版の対象外です。

実装・模擬テスト用の準備段階です。初期値は `SHARED_ENABLED=false`、公開ページの共有URLは未設定です。サーバーの公開・秘密登録・実認証確認なしに共有受信中とは表示しません。既存の気象庁取得、YDITS/Wolfx、強震モニタ中継は残します。

2026-10-14に利用者が提示したDMDATAサポートの回答では、予報以外の再配信が可能と案内されています。メール・個人情報はリポジトリに含めません。予報は各自契約による直接受信のままです。[公式EEW注意事項・再配信ポリシー](https://dmdata.jp/docs/eew/)も確認してください。

## 構成と秘密

`GitHub Pages -> WSS /api/dmdata/stream -> 1つのDurable Object -> DMDATA公式WebSocket 1本`

Cloudflare Workersの別Worker `quakewatch-v15-dmdata` を準備します。既存の `quakewatch-v15-relay`（強震モニタ）は変更しません。固定名のDurable Objectで上流を共有し、最後の閲覧者の切断時に上流も切断します。

APIキーはWorkerのSecret `DMDATA_API_KEY` のみです。GitHub、Pagesビルド、ブラウザ、公開応答、ログには含めません。キーの取得・登録APIもありません。上流チケット、原文エンベロープ、HTTPエラー本文は配りません。ブラウザからの分類・URL・キー指定は受け付けません。

## 管理者が操作すること

1. Cloudflareのプラン・上限と、新Workerの作成先を確認します。有料プランへの変更・決済・契約追加はこの実装では行いません。
2. DMDATAの警報と地震・津波関連の契約、残り接続枠を確認します。上流1枠を使用します。JQuakeの接続やキーは変更・切断しません。
3. サーバー専用キーの権限は `socket.start`、`eew.get.warning`、`telegram.get.earthquake` です。予報権限は不要です。各自入力用キーを公開したり、制限を解除して流用したりしません。サーバー用の接続元IP・ドメイン制限は[公式API資料](https://dmdata.jp/docs/reference/api/v2/)・管理画面・必要に応じサポートで確認してください。PCのIPとCloudflareの送信元は別です。
4. [Cloudflare公式Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)が使える管理端末で、公開用リポジトリのルートから実行します。先に無効の状態でデプロイします。

   ```powershell
   npx wrangler deploy --config workers/wrangler.dmdata.jsonc
   npx wrangler secret put DMDATA_API_KEY --config workers/wrangler.dmdata.jsonc
   ```

   管理者本人が対話欄へ秘密を入力します。チャット、コマンド引数、ファイルには貼り付けません。ダッシュボードから登録する場合も必ずSecretを使用します。
5. 実契約・費用・公開先を確認後、Cloudflare側の通常変数 `SHARED_ENABLED` を文字列 `true` にします。Secretを通常変数へ移さないでください。手元の設定は無効の初期値のため、再デプロイすると停止する点に注意してください。
6. 実際に発行されたWorkerの `/api/dmdata/stream` を確認し、GitHubリポジトリの通常変数 `DMDATA_SHARED_URL` に `https://実際のホスト/api/dmdata/stream` を登録してPagesを再ビルドします。この公開URLにAPIキーを入れないでください。未設定なら既存経路のままです。
7. 公開版の共有DMDATAの接続確認を確認します。実速報・遅延・実機Safariは別途検証が必要です。401/402/403/409では自動再試行を停止し、管理者が設定を直すまで正常受信扱いにしません。他アプリの接続を閉じたり予報へ切り替えたりしません。

## 表示・負荷・停止

- 中継は到達遅延を増やす可能性があります。このアプリだけで防災判断をしないでください。[DMDATAの注意事項](https://dmdata.jp/docs/eew/)を参照してください。
- 警報電文の規模・深さは配信しません。座標・発生時刻の欠測、PLUM・仮定震源でP/Sを捏造しません。
- 通常地震情報の初版は都道府県別最大震度です。観測点の正確な座標を生成せず、同じ地震の既存JMA観測点は保持します。気象庁更新も継続し、取消は対象イベントだけを処理します。
- 接続時の履歴は `replay=true` で渡し、警報音・読み上げを行いません。120秒より古い電文・訓練・試験は共有しません。自動警報は予想最大震度5弱以上という既存条件を維持します。
- オリジン制限はブラウザ向けの利用先制限で、認証や不正利用対策の代わりではありません。共有情報は公開情報でありキーの秘密性とは別です。初期上限は同時64閲覧者です。
- [Cloudflare公式料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)ではSQLite-backed Durable ObjectsはWorkers Freeにもありますが上限があります。外向きWebSocketはハイバネーションしないため閲覧中は稼働時間を消費します。既存の強震モニタ中継も含めアカウントの利用量を確認してください。無料・常時配信を保証せず、有料プランへ自動変更しません。
- 緊急停止は管理者がCloudflareの当該Workerを停止してください。`SHARED_ENABLED` は新規リクエスト時の確認で、既存セッションを即時切断する管理APIではありません。PagesのURLを外すだけで既存タブが直ちに切断されるとは扱いません。

定期自動テストは停止したままです。手動確認は `node --test tests/*.test.mjs`、構文確認、Pagesビルドです。Cloudflare実環境のバンドル・DOのWebSocketアップグレード、秘密設定、実認証はローカル模擬テストとは区別します。
