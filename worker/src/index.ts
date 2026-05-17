import http from 'node:http';
import path from 'node:path';
import { mkdir, readdir, symlink, unlink } from 'node:fs/promises';
import dotenv from 'dotenv';
import pg from 'pg';
import { transcribeSource } from './pipeline/transcribe.js';
import { renderClip } from './pipeline/render.js';
import { renderYoutubeLongClip } from './pipeline/youtube.js';
import type { ClipRow, SourceRow } from './pipeline/shared.js';

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sendJson = (res: http.ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const readJsonBody = async (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
  let body = '';

  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      reject(new Error('Request body too large'));
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      resolve(body ? JSON.parse(body) : {});
    } catch (error) {
      reject(error);
    }
  });
  req.on('error', reject);
});

const startMacHealthServer = () => {
  if (process.env.WORKER_ROLE !== 'mac') return;

  const healthPort = Number(process.env.HEALTH_PORT || process.env.WORKER_HEALTH_PORT || 3033);
  const dataDir = process.env.DATA_DIR || '/data';
  const localDataDir = process.env.LOCAL_DATA_DIR || path.join(process.env.HOME || '', 'clips-data');

  const healthServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, role: 'mac', ts: Date.now() });
      return;
    }

    if (req.method === 'POST' && req.url === '/symlink') {
      try {
        const body = await readJsonBody(req);
        const filepath = String(body.filepath || '');
        const canonicalPath = String(body.canonical_path || '');

        if (!filepath || !canonicalPath) {
          sendJson(res, 400, { error: 'filepath and canonical_path are required' });
          return;
        }
        if (!canonicalPath.startsWith(dataDir)) {
          sendJson(res, 400, { error: `canonical_path must start with ${dataDir}` });
          return;
        }

        const localRelativePath = canonicalPath.slice(dataDir.length).replace(/^\/+/, '');
        const localPath = path.join(localDataDir, localRelativePath);
        await mkdir(path.dirname(localPath), { recursive: true });
        try {
          await unlink(localPath);
        } catch {
          // Nothing to replace.
        }
        await symlink(filepath, localPath);
        sendJson(res, 200, { ok: true, local_path: localPath });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/locate') {
      try {
        const body = await readJsonBody(req);
        const words = body.words as Array<{ text: string; start: number; end: number }>;
        const caption = String(body.signal_caption || body.caption || '').trim();
        const minSec = Number(body.min_sec || 360);
        const maxSec = Number(body.max_sec || 600);

        if (!Array.isArray(words) || words.length === 0) {
          sendJson(res, 400, { error: 'words array is required' });
          return;
        }
        if (!caption) {
          sendJson(res, 400, { error: 'signal_caption is required' });
          return;
        }

        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const { writeFile: wf, mkdtemp, rm } = await import('fs/promises');
        const { tmpdir } = await import('os');
        const execFileAsync = promisify(execFile);

        const scriptsDir = path.resolve(process.cwd(), 'scripts/youtube');
        const python = process.env.PYTHON_BIN || 'python3';
        const workspace = await mkdtemp(path.join(tmpdir(), 'locate-'));

        try {
          const wordsPath = path.join(workspace, 'words.json');
          const srtPath = path.join(workspace, 'transcript.srt');
          await wf(wordsPath, JSON.stringify(words));
          await execFileAsync(python, [path.join(scriptsDir, 'words_to_srt.py'), wordsPath, srtPath]);
          const { stdout } = await execFileAsync(python, [
            path.join(scriptsDir, 'locate_moment.py'),
            '--srt', srtPath,
            '--caption', caption,
            '--min-sec', String(minSec),
            '--max-sec', String(maxSec),
          ]);
          const result = JSON.parse(stdout.trim());
          sendJson(res, result.error ? 422 : 200, result);
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/scan') {
      const sourceDir = process.env.SOURCE_DIR || '';
      if (!sourceDir) {
        sendJson(res, 503, { error: 'SOURCE_DIR env var not set on Mac worker' });
        return;
      }
      try {
        const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.m4v', '.avi', '.webm']);
        const entries = await readdir(sourceDir, { withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
          .map((e) => ({ filename: e.name, filepath: path.join(sourceDir, e.name) }));
        sendJson(res, 200, { ok: true, source_dir: sourceDir, files });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  healthServer.listen(healthPort, '0.0.0.0', () => {
    console.log(`Mac health server listening on port ${healthPort}`);
  });
  healthServer.on('error', (error) => {
    console.error('Mac health server error', error);
  });
};

const requeueStaleWork = async () => {
  await pool.query(
    `UPDATE clips
     SET status = 'pending', updated_at = NOW()
     WHERE status = 'rendering'
       AND updated_at < NOW() - INTERVAL '5 minutes'`
  );
};

const claimClip = async () => {
  const result = await pool.query<ClipRow>(
    `UPDATE clips
     SET status = 'rendering', updated_at = NOW()
     WHERE id = (
       SELECT id
       FROM clips
       WHERE status = 'pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  );
  return result.rows[0] ?? null;
};

const claimSource = async () => {
  const result = await pool.query<SourceRow>(
    `UPDATE sources
     SET status = 'transcribing'
     WHERE id = (
       SELECT id
       FROM sources
       WHERE status = 'transcribing-pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  );
  return result.rows[0] ?? null;
};

const TRANSCRIBE_DISABLED = process.env.TRANSCRIBE_DISABLED === 'true';
const RENDER_DISABLED = process.env.RENDER_DISABLED === 'true';

const loop = async () => {
  while (true) {
    try {
      await requeueStaleWork();

      if (!RENDER_DISABLED) {
        const clip = await claimClip();
        if (clip) {
          if (clip.clip_type === 'youtube_long') {
            await renderYoutubeLongClip(clip);
          } else {
            await renderClip(clip);
          }
          continue;
        }
      }

      if (!TRANSCRIBE_DISABLED) {
        const source = await claimSource();
        if (source) {
          await transcribeSource(source);
          continue;
        }
      }
    } catch (error) {
      console.error('Worker loop error', error);
    }

    await sleep(Number(process.env.WORKER_POLL_MS) || 2000);
  }
};

const start = async () => {
  await pool.query('SELECT 1');
  console.log('clips worker connected to Postgres');
  startMacHealthServer();
  await loop();
};

start().catch((error) => {
  console.error('Worker failed to start', error);
  process.exit(1);
});
