# Local Development / ローカル開発

## English

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Useful variables:

- `VITE_USE_MOCK_TABLEAU=true`
- `VITE_API_BASE_URL=http://localhost:3001`

### Backend

```bash
cd backend
npm install
npm run dev
```

Default local settings:

- `PORT=3001`
- `USE_IN_MEMORY_REPOSITORY=true`
- `TABLEAU_CONTEXT_PROVIDER=mock`
- `CHAT_AGENT_ENABLED=true`
- `CHAT_AGENT_MAX_CONTEXT_PASSES=2`

### Testing

```bash
cd backend
npm test
```

Repository-wide checks:

```bash
npm ci --prefix backend
npm ci --prefix frontend
cd frontend && npx playwright install --with-deps chromium
cd ..
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run test:e2e
npm run ci
```

### Local Smoke Test

```bash
curl http://localhost:3001/health
curl -X POST http://localhost:3001/chat-jobs \
  -H "Content-Type: application/json" \
  -d '{"question":"What is this dashboard?","dashboardContext":{"dashboardName":"Mock","worksheets":[],"filters":[],"parameters":[],"capturedAt":"2026-05-24T00:00:00.000Z"},"clientContext":{"source":"tableau-extension","appVersion":"0.1.0"}}'
```

The `POST /chat-jobs` response returns a `jobId` immediately. Poll `GET /chat-jobs/{jobId}` with the `X-Chat-Owner-Token` header from the create response when auth is disabled.

## 日本語

### フロントエンド

```bash
cd frontend
npm install
npm run dev
```

便利な環境変数:

- `VITE_USE_MOCK_TABLEAU=true`
- `VITE_API_BASE_URL=http://localhost:3001`

### バックエンド

```bash
cd backend
npm install
npm run dev
```

ローカルの既定設定:

- `PORT=3001`
- `USE_IN_MEMORY_REPOSITORY=true`
- `TABLEAU_CONTEXT_PROVIDER=mock`

### テスト

```bash
cd backend
npm test
```

### ローカルスモークテスト

```bash
curl http://localhost:3001/health
curl -X POST http://localhost:3001/chat-jobs \
  -H "Content-Type: application/json" \
  -d '{"question":"What is this dashboard?","dashboardContext":{"dashboardName":"Mock","worksheets":[],"filters":[],"parameters":[],"capturedAt":"2026-05-24T00:00:00.000Z"},"clientContext":{"source":"tableau-extension","appVersion":"0.1.0"}}'
```

