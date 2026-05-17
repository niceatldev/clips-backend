import path from 'path';
import { pool } from '../index.js';
import {
  WHISPER_MODEL,
  ensureDir,
  execFileAsync,
  localTranscriptPath,
  resolveSourcePath,
  tempWorkspace,
  cleanupDir,
  writeJson,
  type SourceRow
} from './shared.js';

type WhisperOutput = {
  language: string;
  duration: number;
  words: Array<{ start: number; end: number; text: string }>;
};

export const transcribeSource = async (source: SourceRow) => {
  const workspace = await tempWorkspace(`source-${source.id}`);

  try {
    const audioPath = path.join(workspace, 'audio.wav');
    const wordsPath = path.join(workspace, 'words.json');
    const persistedTranscript = localTranscriptPath(source.id);
    const sourcePath = await resolveSourcePath(source, workspace);

    await ensureDir(path.dirname(persistedTranscript));

    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      sourcePath,
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      audioPath
    ]);

    await execFileAsync('python3', [
      path.resolve(process.cwd(), 'scripts/transcribe.py'),
      audioPath,
      wordsPath,
      WHISPER_MODEL
    ]);

    const raw = await import('node:fs/promises').then((fs) => fs.readFile(wordsPath, 'utf8'));
    const transcript = JSON.parse(raw) as WhisperOutput;
    await writeJson(persistedTranscript, transcript);

    await pool.query(
      `UPDATE sources
       SET status = 'ready', words = $1::jsonb, duration = COALESCE($2, duration), error = NULL
       WHERE id = $3`,
      [JSON.stringify(transcript.words), transcript.duration || null, source.id]
    );
  } catch (error) {
    await pool.query(`UPDATE sources SET status = 'failed', error = $1 WHERE id = $2`, [
      error instanceof Error ? error.message : String(error),
      source.id
    ]);
    throw error;
  } finally {
    await cleanupDir(workspace);
  }
};
