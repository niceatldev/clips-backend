import dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import path from 'path';
import templatesRouter from './routes/templates.js';
import fontsRouter from './routes/fonts.js';
import sourcesRouter from './routes/sources.js';
import clipsRouter from './routes/clips.js';
import { pool } from './db.js';
import { ensureStorageLayout, paths } from './storage.js';

dotenv.config();

const app = express();
const port = Number(process.env.APP_PORT || 3002);
const frontendDistDir = process.env.FRONTEND_DIST_DIR;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.use('/files', express.static(paths.dataDir));
app.use('/api/templates', templatesRouter);
app.use('/api/templates', fontsRouter);
app.use('/api/sources', sourcesRouter);
app.use('/api/uploads/sources', sourcesRouter);
app.use('/api/clips', clipsRouter);

if (frontendDistDir) {
  app.use(express.static(frontendDistDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) {
      return next();
    }
    res.sendFile(path.join(frontendDistDir, 'index.html'));
  });
}

app.use((err: unknown, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
  console.error('Unhandled route error', err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
});

const start = async () => {
  await ensureStorageLayout();
  await pool.query('SELECT 1');
  app.listen(port, () => {
    console.log(`clips backend server listening on http://localhost:${port}`);
  });
};

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
