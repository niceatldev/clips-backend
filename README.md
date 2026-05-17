# clips-backend

Phase 1 backend for `clips.niceatl.com`.

## Layout

- `server/`: Express API + Postgres persistence + filesystem-backed storage
- `worker/`: polling worker for transcription and render jobs
- `db/init.sql`: bootstrap schema and default template seed

## Local run

1. Copy `.env.example` to `.env`
2. Start Postgres: `docker compose up -d db`
3. Build the frontend in the sibling repo so the server can serve it:
   - `cd ../clips-niceatl-com && npm run build`
   - local compose mounts that dist from `FRONTEND_DIST_HOST_DIR`
   - on the VPS, place the built frontend at `/home/mike/clips/frontend-dist`
4. Install dependencies in both projects:
   - `cd server && npm install`
   - `cd ../worker && npm install`
5. Run locally:
   - `cd server && npm run dev`
   - `cd ../worker && npm run dev`

Or build the full stack with Docker once images are ready:

```bash
docker compose build
docker compose up -d
```
