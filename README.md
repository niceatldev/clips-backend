# clips-backend

Production clip pipeline for `clips.niceatl.com`.

**GitHub:** `https://github.com/niceatldev/clips-backend`  
**Live:** `https://clips.niceatl.com` (served by Caddy on the VPS)

## Repos & Deployment

| Repo | Purpose | Live URL |
|------|---------|----------|
| `niceatldev/clips-backend` | This repo — API server + worker | `clips.niceatl.com` |
| `niceatldev/butternomics-content-engine` | BCE frontend + server | `bce.niceatl.com` |

## Layout

- `server/` — Express API + PostgreSQL + filesystem-backed storage
- `worker/` — polling worker: Whisper transcription + ffmpeg rendering
- `db/init.sql` — schema + default template seed
- `docker-compose.yml` — VPS base stack
- `docker-compose.prod.yml` — VPS production overrides (bind mounts, restart policies)

## Architecture

```
VPS (clips.niceatl.com)
├── clips-app-1       Express API (port 3002)
├── backend-db-1      PostgreSQL 16 (Tailscale only: 100.127.244.92:5433)
└── backend-worker-1  VPS worker (TRANSCRIBE_DISABLED=true, render-only fallback)

Mac Mini (Tailscale: 100.107.38.125)
└── worker (local Node, WORKER_ROLE=mac)
    ├── Whisper large-v3 transcription (primary)
    ├── ffmpeg short clip render + hook PNG
    ├── ffmpeg YouTube long render (16:9, CRF-18, no captions)
    └── Health server :3033
        ├── GET  /health
        ├── GET  /scan       — lists SOURCE_DIR for video files
        ├── POST /symlink    — creates ~/clips-data symlink to actual file
        └── POST /locate     — runs locate_moment.py on a transcript
```

## Worker Split

The Mac Mini is the primary compute node. The VPS worker is a fallback that only renders clips (never transcribes — files live on the Mac's external drive).

| Env var | VPS worker | Mac worker |
|---------|-----------|-----------|
| `WORKER_ROLE` | *(unset)* | `mac` |
| `TRANSCRIBE_DISABLED` | `true` | *(unset)* |
| `RENDER_DISABLED` | `true` | *(unset)* |
| `WORKER_POLL_MS` | `15000` | `1000` |
| `SOURCE_DIR` | — | `/Volumes/SamsungT7/Episodes` (example) |
| `LOCAL_DATA_DIR` | `/data` | `~/clips-data` |

## Clip Types

| Type | Description |
|------|-------------|
| `short` | 9:16 vertical, ASS subtitles, hook PNG overlay, ~90s |
| `youtube_long` | 16:9, libx264 CRF-18 fast, no captions, 6-10 min |

## Episode Registration (Mac files, no upload)

1. BCE `POST /api/mini/scan` → Mac `/scan` lists `SOURCE_DIR`
2. BCE filters already-registered filenames
3. `POST /api/sources/register-prelinked` → `source_id` + `canonical_path`
4. Mac `/symlink` → `~/clips-data/sources/<id>/master.ext` → actual file
5. `POST /api/sources/:id/transcribe` → Mac worker claims + transcribes

## YouTube Long Cut Flow

1. User pastes viral caption → `POST /api/sources/:id/locate` (BCE proxies to Mac)
2. Python `locate_moment.py` finds 6-10 min window → `{in_sec, out_sec, confidence}`
3. `POST /api/clips/youtube` → clip created with `clip_type='youtube_long'`
4. Mac worker auto-locates if `in/out=0`, renders 16:9, pushes output to VPS

## VPS Deployment

```bash
cd /home/mike/clips/backend
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker logs backend-clips-app-1 --tail 50
docker logs backend-worker-1 --tail 20
```

## Mac Worker Deployment

```bash
cd ~/path/to/clips-backend/worker
git pull origin main
npm install
npm run build
# Restart worker process (kill old PID and re-run)
DATABASE_URL=... WORKER_ROLE=mac SOURCE_DIR=/Volumes/SamsungT7/Episodes \
  LOCAL_DATA_DIR=~/clips-data PYTHON_BIN=/usr/local/bin/python3 \
  VPS_CLIPS_URL=http://100.127.244.92:3002 WORKER_SECRET=... \
  node dist/index.js
```

## Local Development

```bash
cp .env.example .env
docker compose up -d db
cd server && npm install && npm run dev
cd ../worker && npm install && npm run dev
```

## Environment Variables

### Server
| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `DATA_DIR` | `/data` | Canonical storage root |
| `APP_PORT` | `3002` | Server port |
| `WORKER_SECRET` | — | Auth for worker PUT endpoints |

### Worker
| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `WORKER_ROLE` | — | Set to `mac` to enable health server |
| `WORKER_POLL_MS` | `2000` | Poll interval (1000 on Mac) |
| `TRANSCRIBE_DISABLED` | — | Set `true` on VPS worker |
| `DATA_DIR` | `/data` | Canonical path prefix (always /data) |
| `LOCAL_DATA_DIR` | `$DATA_DIR` | Where worker actually writes files |
| `SOURCE_DIR` | — | Mac only: folder to scan for episodes |
| `WHISPER_MODEL` | `medium.en` | Whisper model size |
| `PYTHON_BIN` | `python3` | Python binary with whisper + torch |
| `VPS_CLIPS_URL` | — | Base URL to push rendered files to VPS |
| `WORKER_SECRET` | — | Auth header for pushing to VPS |
| `HEALTH_PORT` | `3033` | Mac health server port |
