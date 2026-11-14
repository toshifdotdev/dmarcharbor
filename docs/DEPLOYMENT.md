# Deployment

How production runs, how a release reaches it, and what to do when something
needs a person. Decided 14 November 2026.

## The shape

One AWS account, region **eu-central-1 (Frankfurt)**, beside the Neon database
in `aws-eu-central-1` (the residency decision in `LAUNCH-CHECKLIST.md`).

| Piece | What | Why |
|---|---|---|
| Compute | One `t4g.small` (Graviton, 2 GB, 2 GB swap) running Docker Compose | The cheapest instance that holds the API, the web app and the PDFs. No autoscaling until customers need it; the code is ready for several instances (`LAUNCH-CHECKLIST.md`, "Several instances"). |
| Way in | Cloudflare Tunnel (`cloudflared` container) | No inbound port, no load balancer, no origin certificate. Cloudflare terminates TLS for our hosts and for agencies' domains (Cloudflare for SaaS). |
| Routing | Caddy, inside the instance (`deploy/Caddyfile`) | Sends API hosts and `mta-sts.*` to the API, everything else to the web app, and sets `X-Forwarded-For` from `CF-Connecting-IP`. |
| Images | ECR, `dmarcharbor-api` and `dmarcharbor-web`, private, tags immutable, last 15 kept | Pulled by the instance role; pushed by GitHub Actions through OIDC. |
| Settings | SSM Parameter Store under `/dmarcharbor/prod/` | Encrypted, free at this size, read by the instance at deploy time. |
| Logos | S3 bucket behind CloudFront on its `*.cloudfront.net` name | A separate registrable domain from ours, with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `nosniff`. |
| Logs | CloudWatch Logs, `/dmarcharbor/prod`, 30 days | One stream per container. |
| Database | Neon Postgres, `aws-eu-central-1`, direct (non-pooled) URL | One instance needs no pooler, and `prisma migrate deploy` needs a direct connection. |
| Access | SSM Session Manager | No SSH key exists. |

About USD 18 a month before credits: the instance (12), its disk (2), its public
IPv4 address (3.6), and cents for logs, ECR and CloudFront.

Everything in AWS is one CloudFormation stack, `deploy/aws/stack.yaml`
(`dmarcharbor-prod`). Deleting the stack removes everything except the logo
bucket, which is kept on purpose.

## Hostnames

| Host | Goes to | Notes |
|---|---|---|
| `dmarcharbor.com` | web | The site and the app (`SITE_URL`, `APP_URL`, `BETTER_AUTH_URL`, `CORS_ORIGIN`). The browser reaches the API through the web app's `/api` proxy. |
| `www.dmarcharbor.com` | web | Redirected to the apex by the web app. |
| `api.dmarcharbor.com` | API | Payment webhooks and the report ingest worker. |
| `portal-origin.dmarcharbour.com` | web | Origin for agencies' custom domains (`AGENCY_DOMAIN_ORIGIN`). |
| `portals.dmarcharbour.com` | web | What agencies point their CNAME at (`AGENCY_DOMAIN_CNAME_TARGET`). |
| `mta-origin.dmarcharbour.com` | API | Cloudflare for SaaS fallback origin, for customers' `mta-sts.` hosts. |
| `mta.dmarcharbour.com` | API | `HOSTED_MTA_STS_CNAME_TARGET`. |
| `bimi.dmarcharbour.com` | API | `HOSTED_BIMI_ORIGIN`. |

Every one of these is a proxied CNAME to the tunnel (`<tunnel-id>.cfargotunnel.com`),
and the tunnel sends everything to `http://caddy:80`. `TRUST_PROXY_HOPS=1` on
the API: Caddy is the one proxy it trusts, on both paths (direct, and through
the web app, whose proxy forwards `X-Forwarded-For` without adding to it).

## A release

1. Push to `master`. CI (`ci.yml`) runs every gate.
2. When CI passes, `deploy.yml` builds both images for arm64 on GitHub's arm
   runners, pushes them to ECR tagged with the commit, and runs
   `deploy/deploy.sh <sha>` on the instance through SSM.
3. `deploy.sh` fetches that commit's compose file and Caddyfile, writes the env
   files from Parameter Store, pulls, recreates the containers, and waits for
   `/api/ready`. The API migrates on boot. Expect about a minute in which the
   API answers 502 while it migrates and starts; a single instance cannot hide
   it.

Deploy a given commit by hand: Actions → deploy → Run workflow, with the sha.
Roll back the same way, with the previous sha (its images are still in ECR).
A migration is never rolled back by a deploy: migrations are expand/contract
(`scripts/check-migration-safety.sh`), so the previous release runs on the
newer schema.

## Settings

`deploy/secrets/{api,web,tunnel,deploy}.env` on the operator's machine
(git-ignored), uploaded with `pwsh deploy/aws/put-params.ps1`. Then deploy again
for the containers to read them. The API refuses to boot on a missing
production setting (`apps/api/src/config/env.ts`), so a bad upload fails the
deploy at the readiness wait rather than serving.

- `api/`: every API variable (`LAUNCH-CHECKLIST.md` step 4). Logo storage needs
  only `AWS_REGION`, `LOGO_BUCKET`, `LOGO_CDN_ORIGIN` and `ASSETS_ORIGIN`; the
  instance role signs the requests, so no AWS key is stored.
- `web/`: `API_BASE_URL=http://api:4000`, `SITE_URL`, `HOSTED_BIMI_ORIGIN`.
  `NEXT_PUBLIC_*` are build arguments, set as GitHub environment variables.
- `tunnel/`: `TUNNEL_TOKEN`.
- `deploy/`: `API_HOST`, `BIMI_HOST`, `MTA_ORIGIN_HOST` for the Caddyfile.

`FORENSIC_PII_ENCRYPTION_KEY` cannot be rotated without re-encrypting forensic
rows: keep a copy outside AWS as well.

## When something needs a person

- **Logs:** CloudWatch → Log groups → `/dmarcharbor/prod`, or
  `aws logs tail /dmarcharbor/prod --follow --log-stream-names api`.
- **A shell:** EC2 → the instance → Connect → Session Manager, then
  `sudo -i; cd /opt/dmarcharbor; docker compose --env-file compose.env -f compose.prod.yaml ps`.
- **Restart one container:** the same, with `restart api`.
- **Bigger instance:** update the stack with `InstanceType=t4g.medium`. The
  instance stops and starts (a few minutes down); the disk and settings stay.
- **Several instances later:** an Application Load Balancer or the tunnel's
  own load balancing, plus the items under "Several instances" in
  `LAUNCH-CHECKLIST.md`.
