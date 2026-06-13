# Post Phase 9 Improvement Plan

This plan defines the next phases after Phase 1 to 9.
The intent is to improve quality, safety, demo stability, and maintainability without changing the core product direction.

## Phase 10: Quality Evaluation and Post Improvement Loop

### Purpose

Improve the actual content quality of drafts and make the analysis-to-copy loop more visible.

### Work Items

- Add a scoring / review loop for draft quality.
- Compare copy variants by post type.
- Strengthen the link between Tableau analysis and final post copy.
- Identify repetitive phrasing and refine prompts or templates.
- Introduce a saved-summary reuse path when live analysis is unavailable.

### Likely Files / Areas

- `backend/src/services/actionRunAnalysisService.ts`
- `backend/src/services/actionRunService.ts`
- `backend/src/types/actionRun.ts`
- `backend/test/actionRun*.test.ts`
- `frontend/src/components/PrActionPanel.tsx`

### Done Criteria

- Draft text changes meaningfully by post type.
- Tableau-derived signals visibly influence the output copy.
- At least one fallback path reuses saved analysis or cached summaries.

### Risks

- Overfitting the content to a single demo scenario.
- Making the logic too dependent on prompts rather than explicit rules.

### Recommended Prompt for Codex

> Implement Phase 10 only. Add a quality-evaluation loop for action-run drafts so the final copy better reflects Tableau analysis and is less repetitive. Do not add Slack posting changes or new infra.

## Phase 11: Safety and Approval Flow Hardening

### Purpose

Ensure final output is reviewed by a human before any external publishing path is used.

### Work Items

- Add explicit approval gating before Slack send.
- Separate review-only output from publish-ready output.
- Add photo safety checks for faces, badges, slides, and sensitive background content.
- Add EXIF stripping or metadata handling for uploaded images.
- Add stronger warnings for uncertain or unverified content.

### Likely Files / Areas

- `frontend/src/components/PrActionPanel.tsx`
- `frontend/src/api/actionRunApi.ts`
- `backend/src/services/slackWebhookService.ts`
- `backend/src/services/actionRunService.ts`
- `backend/src/types/actionRun.ts`
- `backend/test/slackWebhookService.test.ts`

### Done Criteria

- Final send cannot happen without explicit confirmation.
- Safety warnings are visible in the UI.
- Image metadata handling is defined.

### Risks

- Slowing down the demo flow too much.
- Creating too many confirmation prompts.

### Recommended Prompt for Codex

> Implement Phase 11 only. Add a human approval flow and safety hardening for final publishing, including clearer review vs publish separation. Do not add new integrations.

## Phase 12: Demo Mode and Fallback Hardening

### Purpose

Make the app resilient when external systems fail during a demo.

### Work Items

- Define an explicit demo mode contract.
- Add deterministic fallback data for Tableau / TechPlay / Drive / image generation.
- Provide copyable fallback output when Slack send fails.
- Add visible fallback assets for missing image generation or S3 failures.
- Standardize error messages shown in the UI.

### Likely Files / Areas

- `backend/src/services/actionRunService.ts`
- `backend/src/services/techplayService.ts`
- `backend/src/services/actionRunImageService.ts`
- `backend/src/services/slackWebhookService.ts`
- `frontend/src/components/PrActionPanel.tsx`
- `frontend/src/env.ts`
- `frontend/src/api/*`

### Done Criteria

- Demo can continue with at least one meaningful fallback when a dependency fails.
- The UI clearly shows whether output is live or fallback-based.

### Risks

- Demo mode leaking into normal operation.
- Confusing users if fallback and live outputs are not labeled clearly.

### Recommended Prompt for Codex

> Implement Phase 12 only. Add demo-safe fallback behavior and make it explicit when the app is using fallback data instead of live integrations. No new product features.

## Phase 13: Legacy Chat / Notion / Env Cleanup and Refactor

### Purpose

Reduce migration noise and remove dead or misleading legacy naming once the new flow is stable.

### Work Items

- Audit `chat`, `message`, `conversation`, and `assistant` naming.
- Separate still-needed shared infrastructure from chat-only logic.
- Review Notion-related code, env, and CloudFormation resources.
- Rename remaining PR-agent concepts where the migration can be done safely.
- Remove dead env vars and dead routes only after confirming no active dependency remains.

### Likely Files / Areas

- `backend/src/handlers/*`
- `backend/src/services/*`
- `backend/src/types/*`
- `frontend/src/components/*`
- `infra/cloudformation.yaml`
- `.github/workflows/*`
- `docs/*`

### Done Criteria

- The remaining codebase reads as a PR-agent app, not a chat PoC.
- Legacy items that remain are explicitly justified.

### Risks

- Accidental deletion of still-used shared utilities.
- Breaking the existing app before the migration is fully complete.

### Recommended Prompt for Codex

> Implement Phase 13 only. Clean up legacy chat/Notion/env naming carefully and remove only dead code after confirming it is not used by the current PR-agent flows.

## Phase 14: Tests, Monitoring, and Cost Management

### Purpose

Increase confidence in correctness and keep operational costs bounded.

### Work Items

- Add E2E tests for the main action flow.
- Add failure-mode tests for Tableau, TechPlay, Drive, image generation, S3, and Slack.
- Add secret-redaction tests.
- Validate correlation IDs and run IDs in logs.
- Add cost guardrails and resource usage checks where feasible.
- Verify S3 lifecycle deletion behavior.

### Likely Files / Areas

- `backend/test/*`
- `frontend/src/**/*.test.tsx`
- `frontend/e2e/*`
- `backend/src/logging.ts`
- `backend/src/services/*`
- `infra/cloudformation.yaml`

### Done Criteria

- Main happy path and key fallback paths are covered.
- Logging is traceable by run ID.
- Cost-sensitive resources are bounded by config.

### Risks

- Test maintenance overhead.
- E2E flakiness if external dependencies are not stubbed correctly.

### Recommended Prompt for Codex

> Implement Phase 14 only. Add tests, logging checks, and cost/retention guardrails for the post-phase-9 action flow. Avoid feature work.

## Phase 15: Documentation and Operations

### Purpose

Make the system easy to set up, demo, troubleshoot, and tear down.

### Work Items

- Consolidate setup steps.
- Document GitHub Variables / Secrets.
- Document AWS resources and teardown steps.
- Document Cognito, Slack, Tableau, and Drive setup.
- Add a demo runbook and a troubleshooting guide.
- Clarify how to register and deploy the Tableau extension.

### Likely Files / Areas

- `README.md`
- `docs/*`
- `infra/README.md`
- `.github/workflows/*`

### Done Criteria

- A new maintainer can set up the app without reading code first.
- A demo operator can run a stable demo and recover from common failures.

### Risks

- Docs becoming stale unless they are updated with code changes.

### Recommended Prompt for Codex

> Implement Phase 15 only. Update docs and operational runbooks for setup, demo, troubleshooting, and teardown. Do not change the product behavior.

## Recommended Next Ordering

1. Phase 10
2. Phase 11
3. Phase 12
4. Phase 14
5. Phase 13
6. Phase 15

The order is intentionally safety-first. Legacy cleanup is useful, but only after the demo behavior and fallback story are stable.

