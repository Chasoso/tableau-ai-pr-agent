# tableau-ai-pr-agent Migration Initial Notes

This file records the safe, non-destructive migration work completed in the current repository snapshot.

## What Was Changed

- Repository/package names were updated to the `tableau-ai-pr-agent` naming family.
- The Tableau extension manifest was re-labeled for the new app name and description.
- The `.trex` URL updater now prefers a new app-specific environment variable, while still accepting the old one for backward compatibility.
- A deletion target list and configuration-difference checklist were added below.

## File-Level Deletion Targets

These files should be removed in a later migration step after the new app path is confirmed. They are intentionally left in place for now.

### Chat-specific

- `backend/src/handlers/chatHandler.ts`
- `backend/src/handlers/chatJobWorkerHandler.ts`
- `backend/src/services/chatService.ts`
- `backend/src/services/chatAgent.ts`
- `backend/src/services/answerGenerator.ts`
- `backend/src/services/promptBuilder.ts`
- `backend/src/services/questionInterpretation.ts`
- `backend/src/services/contextCompressor.ts`
- `backend/src/services/chatJobService.ts`
- `backend/src/services/chatProgress.ts`
- `backend/src/repositories/chatJobRepository.ts`
- `backend/src/repositories/chatHistoryRepository.ts`
- `backend/src/types/chat.ts`
- `backend/src/types/chatJob.ts`
- `backend/src/types/agent.ts`
- `backend/test/chatService.finalAnswer.test.ts`
- `backend/test/chatJobWorkerHandler.test.ts`
- `backend/test/chatJobService.test.ts`
- `backend/test/chatJobService.process.test.ts`
- `backend/test/chatJobService.lifecycle.test.ts`
- `backend/test/chatJobService.auth.test.ts`
- `backend/test/chatJobRoutes.test.ts`
- `backend/test/chatJobRepository.test.ts`
- `backend/test/chatHandler.test.ts`
- `backend/test/chatAgent.test.ts`
- `backend/test/chatAgent.helpers.test.ts`
- `backend/test/chatAgent.bedrock.test.ts`
- `frontend/src/components/ChatPanel.tsx`
- `frontend/src/components/ChatPanel.test.tsx`
- `frontend/src/components/MessageInput.tsx`
- `frontend/src/components/MessageInput.test.tsx`
- `frontend/src/components/MessageList.tsx`
- `frontend/src/components/MessageList.test.tsx`
- `frontend/src/api/chatApi.ts`
- `frontend/src/api/chatApi.test.ts`
- `frontend/src/api/chatJobOwnerToken.ts`
- `frontend/src/api/chatJobOwnerToken.test.ts`

### Notion-specific

- `backend/src/handlers/notionHandler.ts`
- `backend/src/notion/notionService.ts`
- `backend/src/notion/notionOAuthService.ts`
- `backend/src/notion/notionMcpClient.ts`
- `backend/src/notion/notionTokenCrypto.ts`
- `backend/src/repositories/notionRepository.ts`
- `backend/src/types/notion.ts`
- `backend/test/notionService.test.ts`
- `backend/test/notionMcpClient.test.ts`
- `frontend/src/api/notionApi.ts`
- `frontend/src/api/notionApi.test.ts`

### Auth UI pieces to review later

- `frontend/src/components/AuthGate.tsx`
- `frontend/src/components/AuthPopupStart.tsx`
- `frontend/src/components/AuthCallback.tsx`
- `frontend/src/auth/cognitoAuth.ts`
- `backend/src/auth/cognitoAuth.ts`
- `backend/src/auth/cognitoPopupAuthService.ts`
- `backend/src/auth/cognitoPopupAuthCrypto.ts`
- `backend/src/repositories/cognitoAuthTransactionRepository.ts`
- `backend/src/handlers/cognitoPopupAuthHandler.ts`
- `backend/src/types/cognitoPopupAuth.ts`

## Current Rename / Config Diff Summary

### Cognito

- Keep the current flow for now.
- New app-specific names should use the `tableau-ai-pr-agent` prefix for any future parameter/secret names.
- The current code still accepts the existing variables to avoid breaking the old deployment path.

### API Gateway / Lambda

- Keep the HTTP API + Lambda architecture.
- Route names can later move from chat-oriented paths to action-oriented paths.
- No destructive route changes were made in this step.

### Tableau MCP

- Keep the MCP provider and stdio launch path.
- Later tool allowlists should be narrowed to analysis-oriented tools.
- No MCP behavior was changed yet.

### GitHub Actions

- Keep the current workflow shape.
- The new app should eventually use app-specific secret and variable names, but the old names remain accepted for compatibility.
- No workflow files were rewritten in this step.

## CloudFormation Rename Proposal

These names should be used in the next infrastructure pass:

- Stack name: `tableau-chat-extension` -> `tableau-ai-pr-agent`
- Lambda function names: `*-chat` -> `*-action-runner`, `*-chat-job-worker` -> `*-action-job-worker`
- DynamoDB tables: `*-chat-history` -> `*-action-history`, `*-chat-jobs` -> `*-action-jobs`
- API Gateway route groups: `/chat*` -> `/actions*` or `/action-runs*`
- S3 frontend bucket names: use the new app prefix
- CloudFront distribution and OAC names: use the new app prefix
- SSM parameter prefixes: use the new app prefix for any new secrets or keys

## Next Manual Settings To Prepare

### GitHub Secrets / Variables

- `AWS_CFN_STACK_NAME`
- `AWS_GHA_DEPLOY_ROLE_ARN`
- `AWS_CFN_EXECUTION_ROLE_ARN`
- `AWS_ARTIFACT_BUCKET`
- `FRONTEND_BUCKET_NAME`
- `CORS_ALLOWED_ORIGIN`
- `TABLEAU_SERVER_URL`
- `TABLEAU_SITE_CONTENT_URL`
- `TABLEAU_CONNECTED_APP_CLIENT_ID`
- `TABLEAU_CONNECTED_APP_SECRET_ID`
- `TABLEAU_CONNECTED_APP_SECRET_VALUE`
- `TABLEAU_DEFAULT_SUBJECT`
- `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` if Cognito stays enabled
- `COGNITO_REGION`
- `COGNITO_DOMAIN`
- `COGNITO_POPUP_REDIRECT_URI`
- `EXTENSION_SOURCE_URL` or the new `TABLEAU_AI_PR_AGENT_EXTENSION_SOURCE_URL`

### AWS

- CloudFormation stack name for the new app
- S3 artifact bucket for Lambda code
- Frontend hosting bucket
- CloudFront distribution and invalidation permissions
- Cognito User Pool / App Client / domain if auth stays enabled
- Tableau Connected App secret storage strategy
- Any future SSM SecureString prefixes that should use the new app name

### Tableau Cloud

- Allow the extension domain as a network-enabled extension
- Update the extension manifest URL to the new deployed frontend
- Confirm the connected app / site content URL values are correct for the target Tableau site
