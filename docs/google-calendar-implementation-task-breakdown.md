# Google Calendar 実装タスク分解

この文書は、`tableau-ai-pr-agent` に Google Calendar 連携を追加する際の、**ファイル単位の具体的な変更内容** を省略なく残すための実装仕様です。

会話コンテキストが自動圧縮されても、この文書を基準に実装してください。  
もし会話中の説明とこの文書が矛盾した場合は、この文書を優先します。

---

## 目的

PR デモのイベント情報取得を、現在の `mock` 前提から Google Calendar 実装へ段階的に拡張します。

ただし、初期フェーズでは次を守ります。

- UI は変更しない
- フロントは `POST /calendar/resolve` のまま維持する
- Google Calendar の実データ取得は backend に閉じる
- 既存の TechPlay 抽出、投稿案生成、下書き作成フローは壊さない
- まずは `mock` と `google` を切り替え可能にする

---

## 既存アーキテクチャの前提

現在の責務分担は次のとおりです。

- `frontend/src/components/PrActionPanel.tsx`
  - 画面表示
  - 会場写真の追加
  - `resolveCalendarEventContext()` の呼び出し
  - 投稿案作成・下書き作成の実行
- `frontend/src/api/calendarApi.ts`
  - `/calendar/resolve` を呼ぶ API クライアント
- `backend/src/handlers/chatHandler.ts`
  - `/calendar/resolve` ルートを受ける
- `backend/src/services/calendarService.ts`
  - カレンダー候補の検索
  - スコアリング
  - TechPlay URL 検出
  - TechPlay 詳細取得
  - レスポンス整形
- `backend/src/services/techplayService.ts`
  - TechPlay のプレビュー取得

この構成を崩さず、`calendarService.ts` をオーケストレーターにして Google 実装を差し込みます。

---

## 実装方針

### 方針 1: backend に寄せる

Google Calendar API は frontend から直接叩かず、backend でのみ扱います。

理由:

- Google OAuth / refresh token / service account の秘匿情報を frontend に置かなくてよい
- `calendar.resolve` の現在の API 契約をそのまま維持できる
- 将来のモック切り替えや認証方式変更が容易

### 方針 2: provider を分ける

`GOOGLE_CALENDAR_PROVIDER=mock|google` で切り替えます。

- `mock`
  - 既存のデモ用モックを使う
- `google`
  - Google Calendar API 実装を使う

### 方針 3: 中間型を維持する

Google API の生レスポンスをそのまま UI に流さず、既存の `CalendarEventCandidate` / `CalendarResolveResponse` に変換します。

### 方針 4: 小さく分ける

スコアリング、URL 抽出、Google API 呼び出しを別ファイルに分離します。

---

## ファイルごとの具体的な変更内容

## 1. `backend/src/config.ts`

### 変更内容

- `calendar.provider` の既存定義を維持
- `GOOGLE_CALENDAR_PROVIDER` を `mock` / `google` として読む
- Google Calendar 用の設定を追加する

### 追加候補の設定値

- `GOOGLE_CALENDAR_PROVIDER`
- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `GOOGLE_CALENDAR_REFRESH_TOKEN`
- `GOOGLE_CALENDAR_CALENDAR_ID`
- 必要であれば `GOOGLE_CALENDAR_SCOPES`

### 実装メモ

- まずは refresh token 方式で実装するのが最も単純
- もし service account 方式にするなら、ユーザー個別のカレンダーにアクセスできるかを先に確認する
- 実装初期では Google Calendar の認証 UI は作らない

---

## 2. `backend/src/types/calendar.ts`

### 変更内容

- 既存の `CalendarEventCandidate` を Google 実装でも使えるように維持する
- 必要なら Google API の生レスポンスを受ける補助型を追加する

### 追加候補

- `GoogleCalendarEvent`
- `GoogleCalendarListResponse`
- `GoogleCalendarAccessTokenResponse`

### 目的

- Google API の依存を `types/calendar.ts` に閉じない
- アプリ側の中間型を安定させる

---

## 3. `backend/src/services/calendarService.ts`

### 役割

このファイルは **オーケストレーター** にする。

### 変更内容

- `config.calendar.provider` を見て `mock` / `google` を分岐する
- `mock` のときは既存のモックイベント生成を使う
- `google` のときは新設の `googleCalendarService.ts` を呼ぶ
- TechPlay URL 抽出とスコアリングは別モジュールを呼ぶ
- `resolveEventContextFromCalendar()` の返却形式は現状維持する

### 具体的な整理

以下の責務を `calendarService.ts` から外に出す。

- `searchCalendarEvents(postType, now)`
- `scoreCalendarEvent(event, postType, now)`
- `selectBestCalendarEvent(events, preferredEventId)`
- `extractTechPlayUrlsFromCalendarEvent(event)`
- `getSearchWindowLabel(postType)`

### 実装後の責務

- provider 選択
- 候補選択
- TechPlay 取得の有無判定
- 手動フォールバック判定
- 最終レスポンス整形

---

## 4. `backend/src/services/googleCalendarService.ts`

### 新規作成

Google Calendar API の専用クライアント兼検索サービスを追加する。

### 役割

- Google Calendar API からイベント候補を取得する
- 投稿種別と現在時刻に応じて対象期間を決める
- 取得したイベントをアプリ側の `CalendarEventCandidate` に変換する
- 候補が複数ある場合の元データを返す

### 実装内容

- Google API のアクセストークン取得
- Calendar events list 呼び出し
- `summary`
- `description`
- `location`
- `start`
- `end`
- `htmlLink`
- `hangoutLink`
- `attachments`
- `creator`
- `organizer`
- `conferenceData`
  を取得して中間型にマッピングする

### 追加推奨メソッド

- `searchCalendarEvents(postType, now, options)`
- `listCalendarEvents(range, calendarId)`
- `buildGoogleCalendarEventCandidate(event, now)`
- `refreshAccessToken()` もしくは `getAccessToken()`

### 失敗時の扱い

- API 失敗時は `CalendarLookupStatus = "error"` へ落とす
- もしくは `not_found` に倒して warnings を返す
- 認証不備と検索失敗はログで区別する

---

## 5. `backend/src/services/calendarScoring.ts`

### 新規作成

検索候補のスコアリングだけを独立させる。

### 役割

- 現在時刻との近さ
- 投稿種別ごとの対象期間適合
- `Tableau` / `User Group` の含有
- `TechPlay` URL の有無
- location の有無
- 現在イベントかどうか

### 期待する関数

- `scoreCalendarEvent(event, postType, now, venuePhoto?)`
- `selectBestCalendarEvent(events, preferredEventId?)`

### テスト観点

- 現在進行中イベントが最優先になる
- 投稿種別が合う候補が加点される
- TechPlay URL がある候補が加点される
- 複数候補が僅差の場合に候補一覧を返せる

---

## 6. `backend/src/services/calendarTechPlayExtractor.ts`

### 新規作成

Google Calendar のイベント本文や添付から TechPlay URL を抽出する専用モジュールを追加する。

### 抽出対象

- `summary`
- `description`
- `location`
- `htmlLink`
- `attachments`
- `hangoutLink`
- `conferenceData`

### 抽出ルール

- `https://techplay.jp/event/...`
- `http://techplay.jp/event/...`
- `https://techplay.jp/community/...`
- `https://techplay.jp/...`

### 優先順位

1. `/event/`
2. `/community/`
3. それ以外

### 実装メモ

- 他ドメインの URL は無視する
- 複数候補は重複排除する
- 正規化後の URL を返す

---

## 7. `backend/src/services/techplayService.ts`

### 変更内容

- 既存の TechPlay プレビュー取得処理をそのまま再利用する
- Google Calendar から抽出した URL をそのまま渡せるようにする

### 変更しないこと

- TechPlay の HTML 抽出実装を無理に変えない
- UI 側で TechPlay を直接扱わない

---

## 8. `backend/src/handlers/chatHandler.ts`

### 変更内容

- `/calendar/resolve` のルーティングは維持する
- handler ではバリデーションだけ行い、実処理は `calendarService` に委譲する

### 変更しないこと

- `/calendar/resolve` の URL
- request / response の外形
- frontend から見た API 契約

---

## 9. `backend/test/calendarService.test.ts`

### 追加・更新内容

- `mock` provider の現状テストを維持
- `google` provider 用のテストを追加する
- TechPlay URL 抽出とスコアリングを確認する

### 必須のテストケース

- mock provider で既存の候補を返す
- google provider でイベント候補を返す
- `開催中の実況` で現在イベントが最優先になる
- TechPlay URL がイベント本文や添付から抽出できる
- TechPlay 取得失敗時に manual fallback へ落ちる
- 候補が複数ある場合に `multiple_candidates` を返せる

---

## 10. `backend/test/googleCalendarService.test.ts`

### 新規作成

Google Calendar API クライアントのユニットテストを追加する。

### 観点

- access token の生成
- events list 呼び出しの URL / クエリ
- 生レスポンスから中間型への変換
- 失敗時の error 変換

### モック

- `fetch`
- token response
- calendar events response

---

## 11. `backend/test/calendarRoutes.test.ts`

### 変更内容

- `/calendar/resolve` が backend ルートとして維持されることを確認する
- response の `provider`, `calendarLookupStatus`, `techPlayFetchStatus` を確認する

### 目的

- API の外形が変わっていないことを保証する

---

## 12. `README.md`

### 変更内容

- Google Calendar 連携の現在の実装位置を追記する
- `GOOGLE_CALENDAR_PROVIDER=mock` が既定であることを明記する
- Google 実装に必要な env を列挙する
- UI は Google ログインを直接出さないことを明記する

### 追記例

- Google Calendar の実処理は backend にある
- frontend は `POST /calendar/resolve` だけを呼ぶ
- Google 認証 UI は将来の拡張で、現段階では出さない

---

## 13. `docs/github-actions-deployment.md`

### 変更内容

- 既存のデプロイ説明に Google Calendar 実装の切り替え条件を追記する
- `GOOGLE_CALENDAR_PROVIDER=mock` / `google` の使い分けを追記する
- 本番導入時に必要な Google 関連 env を追記する

### 目的

- デプロイ時に「どの環境変数を有効化すべきか」が追えるようにする

---

## 14. `docs/phase15-operations-runbook.md`

### 変更内容

- Google Calendar を本番有効化する場合の運用手順を追記する
- refresh token / service account のどちらを使うかで手順を分岐する
- 失敗時のログ確認ポイントを追加する

---

## 推奨される実装順

1. `backend/src/services/googleCalendarService.ts` を追加
2. `backend/src/services/calendarTechPlayExtractor.ts` を追加
3. `backend/src/services/calendarScoring.ts` を追加
4. `backend/src/services/calendarService.ts` から責務を切り出す
5. `backend/src/config.ts` に Google 設定を追加
6. `backend/test/*.test.ts` を追加・更新
7. `README.md` と `docs/github-actions-deployment.md` を更新
8. 必要なら `docs/phase15-operations-runbook.md` に運用手順を追記

---

## 実装後の受け入れ条件

- `GOOGLE_CALENDAR_PROVIDER=mock` で今まで通り動く
- `GOOGLE_CALENDAR_PROVIDER=google` で Google Calendar からイベントを取得できる
- TechPlay URL は Google Calendar イベントから抽出される
- TechPlay 取得は既存 `techplayService` を再利用する
- frontend の API 契約は変わらない
- 既存の投稿案生成・プレビュー・下書き作成は壊れない
- backend / frontend の lint と typecheck が通る
- 重要な変更はこの文書に追記される

---

## 補足

この文書は、実装の抜け漏れを防ぐための「チェックリスト兼ソース・オブ・トゥルース」です。

実装中に新しい依存や分岐が増えた場合は、まずこの文書を更新してからコードに着手してください。
