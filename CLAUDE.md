# CLAUDE.md: working rules for coding agents on Rooted / OwnPlace

Read this before changing anything. It applies to every agent session: local, cloud (`claude --cloud`, claude.ai/code) or scheduled.

## Who does what

- **Kevin (owner)** decides scope, tests every PR himself and merges. `MkultraUSA` and `Radics` are both Kevin's GitHub accounts; he approves and merges as Radics because GitHub blocks self-review.
- **Agents** implement one issue at a time, open a PR, and stop. **Agents never merge, never push to `main`, never approve PRs.**
- Decision gates are in `docs/ORG-ROLES.md`. The one that matters most: **scope and design are ratified by Kevin before a branch starts** (gate 5). If an issue says the design is ratified, build exactly that. If a task needs a design decision the issue doesn't settle, stop and ask in the PR/issue instead of guessing. `docs/architecture.md` and the "must not guess" list in the product requirements are the boundary.

## Before you start

1. Work from a GitHub issue. The issue body is the spec: design, acceptance criteria, out-of-scope.
2. Branch from the base the issue names (default `main`). Name it `<milestone>/<short-slug>`, e.g. `m14/invite-panel-backend`.
3. `npm install`, then confirm the baseline is green: `npx tsc --noEmit && npm test`.

## Commands

```sh
npm install
npx tsc --noEmit          # typecheck (CI runs this)
npm test                  # node:test via tsx, all packages + apps
npm run build             # web bundle (CI runs this)
npm run publish && npm run verify   # demo stores + verifying clients (CI runs this)
npm run check:secret-paths          # CI secret-path guard
```

CI (`.github/workflows/ci.yml`, job `demo`) runs all of the above on Linux / Node 20. It must be green before a PR is ready. Two tests fail on Windows only (symlink and `/tmp` path assumptions); they pass on Linux.

## Layout

- `packages/protocol`: identity (Ed25519, `identityFingerprint`), canonical hashing, sealing.
- `packages/storage`: `ObjectStore` implementations: `LocalFolderStore`, `WebDavStore`, `HttpsPorchStore` (read-only remote porch).
- `packages/timeline`: publish, verified reads, follow/merge, contacts, invites, pinning.
- `apps/ownplace-web`: `src/server.ts` (API + `/porch/` + `/i/` routes), `src/main.tsx` (React UI).
- `apps/voice-bridge`: **paused. Do not modify** unless an issue explicitly says so.
- `docs/architecture.md`: trust model; update it when behavior changes.

## House style (security invariants; reviewers check these)

- **Fail closed.** Anything unverified is skipped or refused, never shown as authenticated. Unsigned data (e.g. `timeline.json`, invite documents) is a hint only; display comes from Ed25519-verified packages.
- **Public-safe errors.** API responses and public skip reasons never contain raw errors, OS paths, hostnames/IPs, tokens or storage locations. Use fixed messages.
- **Isolation.** One bad porch or package loses only itself; the rest of the read succeeds.
- **No secrets in the repo, ever.** No keys, tokens, `.env` values or private URLs. Tests generate their own keys in temp dirs (`OWNPLACE_IDENTITY_DIR`).
- **Tests never touch the network.** Remote reads take an injectable `fetch` (`FollowOptions`); use it.
- **Every new guard gets a test that fails without it.** Mutation-check it: remove the guard, confirm a test fails, restore. Say so in the PR.
- Match the surrounding code: comment density, `// M<n> #<issue>:` markers on new logic, small functions, no new dependencies unless the issue allows it.
- Do not edit `.github/workflows/` or repo settings.

## Pull request format (required)

Title: `M<n>: <what it does>`. Body sections, in this order:

1. `Closes #<issue>` plus one line on what was ratified. If stacked, say **Stacked on #N** and which base to retarget.
2. **What it does**: user-visible behavior, plain language.
3. **Automated tests**: what's covered, mutation checks done, local and CI results.
4. **How to test it yourself**: exact commands and clicks with **expected results** that Kevin can run on his own machine. This is mandatory; Kevin tests every PR by hand.
5. **Review template**: a fenced block Kevin pastes into his approving review:
   ```
   Tested on <OS>:
   - <step>: <pass/fail>
   Notes:
   ```
6. **Out of scope**: what this deliberately doesn't do.

End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Commit messages end with a `Co-Authored-By:` trailer for the agent.

## When you're stuck

Stop and say so in the PR or issue: what you tried, what's blocked, what decision is needed. Don't widen scope, don't weaken a check to make a test pass, and don't invent a design the issue didn't ratify.
