# Mac Backend Handoff

This document is the source of truth for the current Butternomics Content Engine clips infrastructure.

## Non-Negotiable Structure

The Mac Mini is the backend for storage and CPU work.

The VPS should not render, transcribe, or store new production clip files. It only runs the BCE app, Caddy, and Postgres metadata.

```text
Public user
  -> bce.niceatl.com on VPS
  -> clips.niceatl.com on VPS Caddy
  -> Mac Mini clips API at 100.107.38.125:3002
  -> files in /Users/mikenice/clips-data
```

## Machines

### VPS

- SSH alias: `vps`
- BCE repo: `/home/mike/bce`
- clips-backend repo: `/home/mike/clips/backend`
- Caddy config: `/home/mike/caddy/Caddyfile`
- Clips DB container: `backend-db-1`
- Clips DB address: `100.127.244.92:5433`

Expected clips-backend Docker state:

```text
backend-db-1   running
clips API      stopped unless profile vps-api is intentionally enabled
worker         stopped unless profile vps-worker is intentionally enabled
```

### Mac Mini

- SSH on home LAN: `mikenice@192.168.86.34`
- Tailscale IP: `100.107.38.125`
- Clips API app: `/Users/mikenice/clips-server`
- Clips worker app: `/Users/mikenice/clips-worker`
- Canonical storage: `/Users/mikenice/clips-data`
- API LaunchAgent: `/Users/mikenice/Library/LaunchAgents/com.butternomics.clips-api.plist`
- Worker LaunchAgent: `/Users/mikenice/Library/LaunchAgents/com.butternomics.clips-worker.plist`

## Environment

### BCE on VPS

`/home/mike/bce/.env` should include:

```text
CLIPS_BACKEND_URL=http://100.107.38.125:3002
CLIPS_PUBLIC_URL=https://clips.niceatl.com
```

### Caddy on VPS

`clips.niceatl.com` should reverse proxy to:

```text
100.107.38.125:3002
```

### Mac API

Important env values:

```text
APP_PORT=3002
DATA_DIR=/Users/mikenice/clips-data
DATABASE_URL=postgres://clips:clipspass@100.127.244.92:5433/clips
NODE_ENV=production
```

### Mac Worker

Important env values:

```text
WORKER_ROLE=mac
WORKER_PORT=3033
DATA_DIR=/data
LOCAL_DATA_DIR=/Users/mikenice/clips-data
DATABASE_URL=postgres://clips:clipspass@100.127.244.92:5433/clips
VPS_CLIPS_URL=http://127.0.0.1:3002
```

`VPS_CLIPS_URL` is legacy naming. In this architecture it must point to the local Mac clips API. If it points to `100.127.244.92:3002`, renders will complete locally and then fail while registering/uploading because the VPS clips API is intentionally stopped.

## Storage Rules

The canonical production file tree is:

```text
/Users/mikenice/clips-data
├── sources
├── outputs
├── hooks
├── transcripts
├── fonts
└── tmp
```

Database paths may still be stored as `/data/...`. Do not migrate those casually. The API and worker translate `/data/...` to `/Users/mikenice/clips-data/...` on the Mac.

Old files under `/home/mike/clips/data` on the VPS are legacy/fallback data, not the source of truth for new renders.

## Health Checks

Run these before changing anything:

```bash
ssh vps 'cd /home/mike/clips/backend && docker compose ps'
ssh vps 'curl -sS https://clips.niceatl.com/api/health'
ssh mikenice@192.168.86.34 'curl -sS http://127.0.0.1:3002/api/health'
ssh mikenice@192.168.86.34 'curl -sS http://127.0.0.1:3033/health'
```

Check recent clip statuses:

```bash
ssh vps 'docker exec backend-db-1 psql -U clips -d clips -c "select id, source_id, clip_type, status, left(coalesce(error,''), 300) as error, output_path, updated_at from clips order by updated_at desc nulls last, id desc limit 30;"'
```

Check worker config:

```bash
ssh mikenice@192.168.86.34 'plutil -p /Users/mikenice/Library/LaunchAgents/com.butternomics.clips-worker.plist | egrep "VPS_CLIPS_URL|DATA_DIR|LOCAL_DATA_DIR|DATABASE_URL|WORKER_PORT"'
```

## Restart Commands

Restart Mac clips API:

```bash
ssh mikenice@192.168.86.34 'launchctl kickstart -k gui/501/com.butternomics.clips-api'
```

Restart Mac worker:

```bash
ssh mikenice@192.168.86.34 'launchctl kickstart -k gui/501/com.butternomics.clips-worker'
```

Restart BCE app on VPS:

```bash
ssh vps 'cd /home/mike/bce && docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d app'
```

## Common Failure Modes

### Render shows failed but Mac CPU was active

Likely cause: worker rendered the file, then failed to register it because `VPS_CLIPS_URL` pointed to the stopped VPS API.

Fix:

```bash
ssh mikenice@192.168.86.34 'plutil -replace EnvironmentVariables.VPS_CLIPS_URL -string http://127.0.0.1:3002 /Users/mikenice/Library/LaunchAgents/com.butternomics.clips-worker.plist && launchctl kickstart -k gui/501/com.butternomics.clips-worker'
```

If output and hook files already exist, repair the DB row instead of re-rendering blindly:

```sql
update clips
set status='done',
    output_path='/data/outputs/<clip_id>/output.mp4',
    error=null,
    updated_at=now()
where id=<clip_id>;
```

Only do this after verifying both files exist under `/Users/mikenice/clips-data/outputs/<clip_id>/output.mp4` and `/Users/mikenice/clips-data/hooks/<clip_id>/hook.png`.

### BCE app is slow or VPS CPU is pinned

Check that the VPS worker is not running:

```bash
ssh vps 'cd /home/mike/clips/backend && docker compose ps'
```

Only `backend-db-1` should be running from clips-backend during normal production.

### Episodes or clips disappear from UI

Check:

- BCE `.env` points `CLIPS_BACKEND_URL` to `http://100.107.38.125:3002`
- Caddy points `clips.niceatl.com` to `100.107.38.125:3002`
- Mac API health is good
- Public clips health is good

### Hook font looks wrong

The production hook font should resolve from Mac storage. Current production template uses font row `2`, file:

```text
/Users/mikenice/clips-data/fonts/2/Arial Black.ttf
```

Do not assume Docker `/data/fonts/...` exists on the Mac. The worker has path translation for `/data/...`.

## Claude Onboarding Notes

Before making changes:

1. Read this file.
2. Verify health checks.
3. Confirm `docker compose ps` in `/home/mike/clips/backend` only shows the DB in normal production.
4. Do not restart VPS clips API or worker to "fix" missing clips.
5. Do not move files back to VPS storage.
6. Keep Mac Mini as the storage and CPU authority.
7. If a render fails, inspect the DB row, Mac output files, and Mac worker endpoint before requeueing.

The most important current rule: the live app works through Mac API + Mac worker + Mac storage. Preserve that structure first, then debug.
