# Open Accountant on your own Cloudflare account

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/openaccountant/selfhost-cloudflare)

> The button needs this directory published as a **public** repo. `openaccountant/course`
> (where this lives today) is private. See "Publishing" below.

Runs **one** copy of wilson (the Open Accountant CLI) and its dashboard for **you**, in a
Cloudflare Container on your account:

- Your data directory (`~/.openaccountant`) is saved to **your R2 bucket** every 10 minutes
  while it runs and right before it goes to sleep, and restored when it wakes up.
- It **refuses to serve** anything until it sits behind **Cloudflare Access** and the Worker
  can verify the Access login token (`Cf-Access-Jwt-Assertion`) for your team and app.
- Optional cloud AI: add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` as Worker secrets.

Full guide: https://docs.openaccountant.ai/getting-started/self-host-cloudflare/

## Trade-off, plainly

Your financial data lives in **your Cloudflare account** (R2 + a container), not on your
laptop. Nobody else's servers are involved, but it is in the cloud, and anyone who can sign
in to your Cloudflare account can read it. If you want it on your own machine only, use the
regular install instead: https://openaccountant.ai/get-started

## Cost

- **Workers Paid**: $5/month (required for Containers).
- **Container time** while it is awake (`basic`: 1/4 vCPU, 1 GiB). It sleeps after 30 minutes
  idle, so a couple of hours a day stays near the plan's included usage. Check
  https://developers.cloudflare.com/containers/pricing/ for current rates.
- **R2**: snapshots are small (tens of KB to a few MB); well inside the free tier for most people.

## Setup

1. Deploy (button above, or `npm install && npx wrangler deploy`). This creates the Worker,
   the container, and an R2 bucket `open-accountant-data`.
2. Zero Trust → Access → Applications → **Add a self-hosted application** for the Worker's
   hostname (`open-accountant.<you>.workers.dev`, or a custom domain). Policy: allow only your email.
3. Copy the application's **Audience (AUD) tag** and your team domain
   (`<team>.cloudflareaccess.com`). Set them as Worker variables:
   `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` (Workers → open-accountant → Settings → Variables).
4. Open the hostname, sign in through Access. The first load starts the container (~30 s).
   - `/` is the wilson dashboard. `/_oa/` is a terminal with `wilson` on the PATH and a
     "Snapshot now" button.

## How it works

```
Browser ─ Cloudflare Access ─ Worker (verifies the Access JWT, fails closed)
                                 └─ OwnerSandbox Durable Object (id "owner")
                                      ├─ container: wilson 0.10.0 + dashboard (loopback) + forwarder
                                      ├─ boot(): restore snapshots/latest.tgz from R2, start dashboard
                                      ├─ every SNAPSHOT_EVERY_MIN: snapshot → R2
                                      └─ before idle sleep: snapshot → R2
```

Snapshots: `snapshots/latest.tgz` plus timestamped history (last `KEEP_SNAPSHOTS`, default 48).
SQLite files are copied with `VACUUM INTO`, so a snapshot taken while wilson runs is consistent.
To restore an older one, copy it over `snapshots/latest.tgz` in the R2 dashboard and restart
the container (redeploy, or wait for it to sleep).

Known limits:
- Anything written in the last few minutes before a crash (not a normal sleep) can be lost;
  lower `SNAPSHOT_EVERY_MIN` if that matters to you.
- Secrets you add are passed into your container's environment so wilson can call the model.
- Bank sync (Plaid) and other paid features still need your Open Accountant license.

## Publishing (maintainers)

The Deploy button clones a public GitHub repo. Publish this directory on its own:

```bash
git subtree split --prefix selfhost -b selfhost-publish
git push git@github.com:openaccountant/selfhost-cloudflare.git selfhost-publish:main
```
