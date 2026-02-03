---
name: trigger-webhook-security
description: Implements webhook signature verification for trigger nodes. Use when adding security to trigger nodes like FigmaTrigger, LinearTrigger, or any webhook-based trigger node. Reads Linear tickets, researches APIs, implements solutions, runs tests, and creates PRs.
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*), Bash(curl:*), Read, Grep, Glob, Write, StrReplace, WebSearch, WebFetch
---

# Trigger Webhook Security

Add HMAC signature verification to webhook trigger nodes.

## Goal

Given a Linear ticket (NODE-XXXX) for a trigger node, implement webhook signature verification so only authentic requests are processed.

## Available Resources

**Linear MCP** (server: `user-Linear`):
- `get_issue` - Read ticket details (node name, requirements, branch name)
- `create_comment` - Report findings or blockers

**Shared utility** (USE THIS):
- `utils/webhook-signature-verification.ts` - reusable `verifySignature()` function
- `utils/__tests__/webhook-signature-verification.test.ts` - test examples

**Reference implementations** in `packages/nodes-base/`:
- Typeform: `nodes/Typeform/TypeformTrigger.node.ts` + `TypeformTriggerHelpers.ts` (uses shared utility)
- Slack: `nodes/Slack/SlackTrigger.node.ts` + `SlackTriggerHelpers.ts` (uses shared utility)
- Currents: `nodes/Currents/CurrentsTrigger.node.ts` + `CurrentsTriggerHelpers.ts` (uses shared utility)


## Shared Utility Usage

Import from `utils/webhook-signature-verification.ts` and call with options:

```typescript
import { verifySignature } from '../../utils/webhook-signature-verification';
```

**Options:**
- `getExpectedSignature`: Compute HMAC signature (return `null` if missing data)
- `skipIfNoExpectedSignature`: Return `true` when no secret (backwards compatibility)
- `getActualSignature`: Get signature from request header
- `getTimestamp` (optional): Enable replay attack prevention
- `skipIfNoTimestamp` (optional): Skip timestamp check if header missing
- `maxTimestampAgeSeconds` (optional): Default 300 (5 minutes)

## Secret Source Patterns

| Pattern | When | Secret Source |
|---------|------|---------------|
| Auto-generate | API accepts secret on webhook creation | `randomBytes(32).toString('hex')` |
| Fetch from API | API provides secret after creation | `GET /webhooks/{id}/signing_secret` |
| User-provided | User configures in credentials | `this.getCredentials()` |

## What to Implement

| File | Test File Required |
|------|-------------------|
| `{NodeName}TriggerHelpers.ts` | `__tests__/{NodeName}TriggerHelpers.test.ts` |
| `{NodeName}Trigger.node.ts` | `__tests__/{NodeName}Trigger.node.test.ts` |

**Every changed file must have a corresponding test file covering the changes.**


## Key Requirements

- **Use the shared utility** `utils/webhook-signature-verification.ts` (handles `timingSafeEqual` internally)
- **Use `getNodeWebhookUrl('default')`** for URL construction
- Backwards compatible: return `true` if no secret configured (use `skipIfNoExpectedSignature`)
- Return 401 Unauthorized for invalid signatures
- Store secret in `webhookData.webhookSecret` (workflow static data) when auto-generating
- **All tests must pass before creating PR**

## Workflow

1. **Read Linear ticket** → get node name and requirements
2. **Assign ticket to me** with `no-docs-needed` label
3. **Create branch** per AGENTS.md conventions
4. **Research API docs** → find signature header, format, algorithm (HMAC type, encoding)
5. **Implement** using shared utility `utils/webhook-signature-verification.ts`
6. **Write tests** for every changed file (study existing test files for patterns)
7. **Run tests** → `pnpm test {NodeName}` - must all pass
8. **Validate** → run from `packages/nodes-base/`:
   - `pnpm typecheck` (fast)
   - `pnpm eslint nodes/{NodeName}/` (lint only changed node, much faster than full lint)
9. **Create PR** using `/create-pr` skill

## If API Doesn't Support Signatures

Comment on Linear ticket with:
- Documentation URLs reviewed
- Finding: what's missing (no signing endpoint, no signature headers, etc.)
- Do NOT implement partial solutions

## PR Guidelines

**Do NOT mention in PR title/description:**
- Security vulnerabilities or attack vectors
- "Fixes security issue" or similar phrases
- Details about what was unprotected

The repo is public. Keep PR descriptions neutral and feature-focused.

## Success Criteria

- [ ] Signature verification implemented
- [ ] Every changed file has corresponding test file
- [ ] All tests pass
- [ ] Typecheck passes (in `packages/nodes-base/`)
- [ ] Lint passes on changed files
- [ ] PR created: `feat({NodeName} Trigger Node): Add webhook signature verification`
