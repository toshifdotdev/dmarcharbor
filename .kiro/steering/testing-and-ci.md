---
inclusion: always
---

# Testing: slow suites run on GitHub Actions, not locally

The user's standing rule: **integration tests and anything else that takes a long time run in CI (GitHub Actions), never locally.** The repo is public, so Actions minutes are free. CI's full run takes about 10 minutes; the same work locally takes most of an hour and slows the machine.

## What to run where

Locally (quick gates only):
- API, in `apps/api`: `npm run typecheck`, `npm run lint`
- API unit tests: only the files you touched, e.g. `npx vitest run --config vitest.config.ts tests/<file>.unit.test.ts`
- Web, from the repo root: `npx tsc --noEmit -p apps/web/tsconfig.json`, `npx eslint apps/web`, `npm run test --workspace @dmarcharbor/web`
- The browser clickthrough (`apps/web`: `$env:NODE_OPTIONS='--dns-result-order=ipv4first'; node scripts/verify-run.mjs`) stays local, because CI does not run it.

In CI (push the branch and watch the run):
- The full API unit suite, the **whole integration suite**, migrations, both builds, the migration safety check, `npm audit --audit-level=high --omit=dev`, and the container build and boot.
- `.github/workflows/ci.yml` runs on every push to `feat/**`, and can be started by hand with `workflow_dispatch`.

Watch a run:

```powershell
Start-Sleep 20; $id = gh run list --branch <branch> --limit 1 --json databaseId --jq '.[0].databaseId'; gh run watch $id --interval 30 --exit-status; gh run view $id --log-failed
```

A change is not done until its CI run is green. Report the run id.

## Prompts for other agents

Every implementation prompt written for another agent (e.g. DeepSeek) must include this rule: run only the quick gates locally, commit and push to the feature branch, and use the GitHub Actions run for integration tests and other slow checks. Include the watch command above and ask for the run id in the report.
