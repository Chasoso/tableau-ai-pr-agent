# Codex Working Rules

この文書は、`tableau-ai-pr-agent` で Codex が作業するときの基準です。

## 作業前のリポジトリ確認

作業開始時に必ず次を確認します。

- 現在の作業ディレクトリ
- `git remote -v`
- `git status`
- `package.json` の `name`
- `README` のタイトル

確認した結果、`Chasoso/tableau-ai-pr-agent` と `tableau-ai-pr-agent` に一致しない場合は、作業を止めて報告します。

特に旧アプリ名を向いている場合は、ファイル変更を行いません。

## 1 回 1 Phase

- 1 回の依頼で進めるのは 1 Phase だけにします
- Phase をまたいだ実装はしません
- 次の Phase に進む前に、現 Phase の目的を満たしたかを確認します

## 破壊的変更の扱い

- 破壊的変更は事前に提案します
- 既存アプリを壊す変更は勝手に行いません
- チャット機能や Notion 関連の削除は、明示指示があるまで行いません

## chat / notion 削除禁止の一時ルール

移行期間中は次を削除しません。

- chat 関連ファイル
- Notion 関連ファイル
- 既存の連携コード

段階移行の準備が整うまでは、置換よりも追加を優先します。

## infra / GitHub Actions 変更の扱い

- infra、GitHub Actions、CloudFormation は小さく分けて変更します
- 1 回で複数の基盤変更をまとめません
- 影響範囲が大きい場合は、先に方針を報告します

## Secrets の露出禁止

次を README、docs、ログ、サンプル値に出しません。

- `.env`
- トークン
- Webhook URL
- AWS キー
- Tableau secret
- Cognito secret
- AWS アカウント ID

必要な場合はプレースホルダのみを書きます。

## build / test / typecheck 確認

- 変更後は可能な範囲で `build`、`test`、`typecheck` を実行します
- 失敗した場合は、失敗内容をそのまま報告します
- 実行できない場合は、未実施理由を明記します

## 作業後の報告フォーマット

作業後は必ず次を報告します。

- 変更したファイル一覧
- 実行した確認コマンド
- 成功 / 失敗
- 未実施事項
- 次にやるべきこと

## 補足

- アプリ本体、frontend、backend、infra、GitHub Actions は、今回のようなドキュメント作成だけの依頼では変更しません
- もし現在の作業対象が期待リポジトリと違うなら、先に止めます
