# clips-backend

Production clip pipeline for Butternomics Content Engine 4.0.

**GitHub:** `https://github.com/niceatldev/clips-backend`  
**Public clips API:** `https://clips.niceatl.com`

## Current Architecture

The Mac Mini is the production clips backend for storage and CPU work.

The VPS only runs:

- Butternomics Content Engine app
- Caddy reverse proxy
- PostgreSQL for clips metadata

Do not restart the old VPS clips API or VPS worker unless Brandon explicitly asks for emergency fallback. They are opt-in Docker Compose profiles now.

```text
VPS
├── bce.niceatl.com app
├── Caddy: clips.niceatl.com -> 100.107.38.125:3002
└── backend-db-1 Postgres: 100.127.244.92:5433

Mac Mini
├── clips API: com.butternomics.clips-api, port 3002
├── render/transcribe worker: com.butternomics.clips-worker, port 3033
└── canonical files: /Users/mikenice/clips-data
```

See `MAC_BACKEND_HANDOFF.md` before changing deployment, storage, worker, Caddy, or Docker settings.

## Layout

- `server/` - Express API + PostgreSQL + filesystem-backed storage
- `worker/` - polling worker: Whisper transcription + ffmpeg rendering
- `db/init.sql` - schema + default template seed
- `docker-compose.yml` - VPS DB plus opt-in emergency profiles
- `MAC_BACKEND_HANDOFF.md` - live architecture and Claude handoff notes

## Production Rules

- Source videos, rendered clips, hook PNGs, transcripts, and fonts live on the Mac at `/Users/mikenice/clips-data`.
- Database paths may still look like `/data/...`; the Mac API and worker translate those to the local Mac data directory.
- `clips.niceatl.com` should proxy to the Mac API at `100.107.38.125:3002`.
- The Mac worker should push completed renders to `http://127.0.0.1:3002`, not to the stopped VPS clips API.
- The VPS clips API and worker services are fallback only:
  - API profile: `vps-api`
  - worker profile: `vps-worker`

## Health Checks

```bash
# VPS
ssh vps 'cd /home/mike/clips/backend && docker compose ps'
ssh vps 'curl -sS https://clips.niceatl.com/api/health'

# Mac Mini
ssh mikenice@192.168.86.34 'curl -sS http://127.0.0.1:3002/api/health'
ssh mikenice@192.168.86.34 'curl -sS http://127.0.0.1:3033/health'
```

## Local Development

```bash
cp .env.example .env
docker compose up -d db
cd server && npm install && npm run dev
cd ../worker && npm install && npm run dev
```
