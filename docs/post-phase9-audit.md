# Post Phase 9 Audit

## Scope

This audit reviews the repository after Phase 1 to Phase 9 are assumed complete:

1. AI PR Action UI
2. Action Runs API
3. TechPlay page loading
4. Tableau MCP analysis specialization
5. Slack webhook posting
6. S3 image storage
7. Image generation
8. Smartphone photo upload
9. Google Drive reference support

The goal is not to change implementation now. The goal is to identify remaining quality, safety, operational, demo-stability, and maintainability gaps.

## Current Assessment

The product direction is coherent:

- The UI is no longer chat-first.
- The action-run flow exists end to end.
- Tableau context, TechPlay context, image generation, Slack delivery, and reference inputs are conceptually connected.

However, the repo still looks like a staged migration rather than a fully hardened production tool. The main gaps are:

- Demo resilience is not yet explicit enough.
- Human confirmation and safety checks are present only in UI-level guidance.
- Some code and docs still carry legacy chat / Notion naming.
- The system has not yet separated demo-safe fallbacks from real integrations.
- Test coverage is good for core flows, but not yet broad enough for failure modes and end-to-end confidence.

## Findings by Area

### 1. Demo Stability

Current state:

- Core happy paths are covered.
- UI previews exist for the main inputs and outputs.
- Some fallbacks are already implicit, such as placeholder content when external data is not available.

Remaining issues:

- Tableau MCP failure handling is not yet clearly separated into:
  - cached summary
  - stubbed demo result
  - user-facing fallback explanation
- TechPlay loading failure is still mostly a UI error state, not a demo-resilient fallback.
- Google Drive support is currently a local placeholder, not a real fallback strategy.
- Image generation failure needs a visible fallback asset path or a safe placeholder.
- S3 save failure needs a deterministic fallback behavior for demo runs.
- Slack send failure needs a copyable fallback output in the UI.
- There is no explicit demo mode contract yet.

Impact:

- Medium to high for demos.
- Low to medium for normal development.

Priority:

- High for demo readiness.

### 2. Human Confirmation and Safety

Current state:

- The UI encourages review.
- The preview surface shows draft text, evidence, checks, and contextual inputs.
- Smartphone photo upload is explicitly framed as contextual, not fully automatic posting.

Remaining issues:

- There is no explicit approval gate before Slack send.
- There is no separate policy for X / external posting reuse.
- The system does not yet enforce image safety checks for faces, name badges, slides, or sensitive background content.
- EXIF stripping is not addressed.
- Oversharing prevention is still based on content prompts and manual review.
- Fully automatic posting is still conceptually possible if future phases are wired too aggressively.

Impact:

- High for safety and trust.

Priority:

- Highest.

### 3. Slack Output Quality

Current state:

- Slack payload generation exists.
- Review context is sent alongside the draft.
- Image attachment support is conceptually in place.

Remaining issues:

- Review message and external-post copy are not clearly separated.
- The Slack message structure needs a stable block layout for maintainability.
- It is unclear whether multiple candidate drafts should be shown when confidence is low.
- If Slack send fails, the UI does not yet expose a polished fallback that is easy to copy.

Impact:

- Medium for demo quality.
- High for operational clarity.

Priority:

- High.

### 4. Tableau MCP Analysis Quality

Current state:

- Fixed analysis direction is in place.
- Tableau is no longer open-ended chat.

Remaining issues:

- It is not yet guaranteed that the analysis output is strongly reflected in the final post copy.
- There is a risk that Tableau insight only appears in evidence, not in the draft text.
- Analysis dimensions are likely still too shallow for publication planning.
- There is no saved-summary reuse strategy when MCP is unavailable.

Impact:

- High for product value.

Priority:

- High.

### 5. Generation Quality

Current state:

- The app produces a draft post, image frame, evidence, checks, and hashtags.
- The image path is deterministic and demo-oriented.

Remaining issues:

- Copy may still become repetitive.
- Tone variation by post type needs stronger enforcement.
- Hashtag count and hashtag diversity need validation.
- Generated image quality may be acceptable for a scaffold, but not yet obviously “demo-ready” if typography or aspect ratio fails.
- There is no fallback image strategy if generation fails.

Impact:

- Medium to high for perceived quality.

Priority:

- High.

### 6. Permissions and Auth

Current state:

- Cognito auth and Tableau extension access patterns exist.
- Slack and Drive are not yet fully hardened.

Remaining issues:

- Callback/logout URLs should be checked against the final deployed CloudFront / distribution URL.
- The app may need separate permissions for:
  - generating drafts
  - sending Slack messages
  - reading Drive references
- Slack destination strategy is not yet fully defined:
  - fixed channel
  - user-selected channel
  - per-demo channel
- Drive permissions may be broader than necessary for the initial MVP.

Impact:

- High for deployment correctness and least-privilege posture.

Priority:

- High.

### 7. Secrets and Environment Variables

Current state:

- Configuration exists across frontend, backend, infra, and GitHub Actions.
- The repository already uses env-driven wiring.

Remaining issues:

- Required vs optional env variables need a single authoritative list.
- Some env names are legacy-shaped from the chat app and should be reviewed.
- Frontend `VITE_` variables must be audited to ensure no secret leakage.
- README / docs should avoid sample values that look like account IDs or secrets.

Impact:

- High for maintainability and safety.

Priority:

- High.

### 8. Legacy Chat / Notion Code

Current state:

- The app is functionally moving away from chat-first behavior.
- Some legacy naming remains intentionally to preserve staged migration safety.

Remaining issues:

- `chat`, `message`, `conversation`, `assistant` naming may still be surprising in the PR agent context.
- Some Notion-related code paths and env names may remain from earlier work.
- Some legacy files should stay until the new flows are fully proven.

Suggested classification:

- Keep for now:
  - shared auth primitives
  - shared async job infrastructure
  - reusable API / handler scaffolding
  - any code still needed by existing chat PoC until migration completes
- Delete later:
  - chat-only UI components
  - Notion-only routes and env wiring
  - any dead code not referenced by Phase 1 to 9 flows

Priority:

- Medium now, high later.

### 9. Tests

Current state:

- There is good coverage for happy-path unit tests.
- Some integration-like tests already exist.

Remaining issues:

- Failure-mode tests are not yet comprehensive.
- End-to-end coverage for the full action flow is still limited.
- Secret-redaction tests should be explicit.
- Fallback behavior tests are still needed for each major integration.

Priority:

- High.

### 10. Logging, Monitoring, and Cost

Current state:

- Structured logs exist.
- The system appears to use run identifiers and stage updates.

Remaining issues:

- A single runId / correlationId should be traceable across UI, API, worker, analysis, image generation, S3, and Slack.
- Logs should be checked for accidental secret leakage.
- Bedrock timeouts and token limits should be bounded and monitored.
- S3 lifecycle behavior should be verified after deployment.
- CloudWatch log volume and image-generation cost should be considered.

Priority:

- High for ops, medium for demo-only environments.

### 11. Documentation

Current state:

- Roadmap and working rules exist.

Remaining issues:

- Setup steps, secrets inventory, AWS layout, Slack setup, Tableau setup, Drive setup, and demo runbook still need consolidation.
- Troubleshooting and teardown steps are not yet crisp enough for non-authors.

Priority:

- Medium now, high before external demo.

## Findings Summary

### High priority issues

- No explicit demo mode contract.
- No first-class human approval gate before Slack send.
- Fallback behavior is not yet standardized for Tableau, TechPlay, Drive, image generation, S3, and Slack.
- Legacy naming remains and can confuse maintainers.
- Secret exposure prevention needs a single documented source of truth.
- End-to-end failure-mode tests are still thin.

### Medium priority issues

- Post quality may be repetitive.
- Slack block structure could be simplified and stabilized.
- Analysis-to-copy coupling could be stronger.
- Drive support is still a local placeholder.

### Low priority issues

- Cosmetic cleanup of remaining legacy naming where it does not affect flow.
- Fine-grained styling polish that does not affect demo stability.

## Impact and Priority Matrix

| Area | Impact | Priority | Notes |
| --- | --- | --- | --- |
| Demo stability | High | High | Biggest risk for live demos |
| Human safety | High | Highest | Needed before any external posting |
| Slack quality | Medium | High | Directly affects the output experience |
| Tableau analysis | High | High | Core product value |
| Generation quality | Medium | High | Determines perceived maturity |
| Permissions/auth | High | High | Important for deployment correctness |
| Secrets/env | High | High | Security and maintenance risk |
| Legacy code cleanup | Medium | Medium | Better after behavior is stable |
| Tests | High | High | Needed for confidence |
| Logging/cost | Medium | High | Important for ops stability |
| Documentation | Medium | Medium | Becomes critical before handoff/demo |

## Recommended Immediate Actions

### Must do before demo

- Add a clear demo-safe fallback strategy for each external dependency.
- Add an explicit human confirmation step before Slack send.
- Verify that the generated post text is not too repetitive across post types.
- Make sure photo upload and Drive reference are treated as contextual inputs, not automatic publication triggers.
- Add end-to-end failure-mode tests for the main happy path plus one fallback per integration.

### Can wait until after demo

- Removing all legacy chat / Notion naming.
- Replacing placeholder Drive support with real OAuth and Drive API.
- Polishing all image aesthetics and layout details.
- Full multi-candidate generation UX.

## Required Before External Demo

- Demo mode or fixed-data fallback policy.
- Human approval step for final Slack send.
- Fail-closed behavior for uncertain content.
- Copyable fallback output when Slack or image generation fails.
- Confirmed env list and deployment config.
- A short demo runbook.

## Required Before Production Use

- Real Drive OAuth and scoped access.
- Stronger safety checks for images and text.
- Secret storage hardening.
- Monitoring and alerting.
- Broader tests, including E2E and failure cases.
- Clear permission separation for draft generation vs posting.

