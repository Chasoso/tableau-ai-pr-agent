# Phase 15 Operations Quick Reference

デモ担当者向けの短い確認表です。詳細は [Phase 15 Operations Runbook](phase15-operations-runbook.md) を参照してください。

## デモ前

- `DEMO_MODE=true` を必要に応じて有効化する
- `MODEL_PROVIDER=mock` または安定した Bedrock 設定を選ぶ
- `TABLEAU_CONTEXT_PROVIDER` が想定どおりか確認する
- `SLACK_INCOMING_WEBHOOK_URL` を送信先と照合する
- `PR_ACTION_IMAGE_BUCKET_NAME` と `PR_ACTION_IMAGE_PUBLIC_BASE_URL` を確認する
- `AUTH_REQUIRED` と `COGNITO_*` を確認する

## デモ中

- 投稿タイプ
- イベント名
- TechPlay URL
- 現在の状況
- 必要なら会場写真
- 必要なら Drive brief
- 生成結果の根拠と確認ポイント
- Slack 送信前の人間確認

## デモ後

- `runId` を控える
- 送信成功 / 失敗を記録する
- 外部送信したかどうかを記録する
- CloudWatch Logs を確認する

## 削除前

- Slack の送信経路を止める
- S3 bucket 内の画像を削除する
- DynamoDB テーブルを削除する
- CloudFormation stack を削除する
- GitHub Secrets / Variables を片付ける

