CREATE TABLE IF NOT EXISTS sources (
  id           SERIAL PRIMARY KEY,
  filename     TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  duration     NUMERIC,
  status       TEXT NOT NULL DEFAULT 'uploading',
  words        JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS templates (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  config      JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fonts (
  id           SERIAL PRIMARY KEY,
  template_id  INT REFERENCES templates(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  filename     TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clips (
  id           SERIAL PRIMARY KEY,
  source_id    INT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  template_id  INT REFERENCES templates(id),
  in_seconds   NUMERIC NOT NULL,
  out_seconds  NUMERIC NOT NULL,
  hook_text    TEXT,
  hook_visible JSONB,
  spec         JSONB,
  clip_type        TEXT NOT NULL DEFAULT 'short',
  signal_caption   TEXT,
  suggested_titles JSONB,
  status           TEXT NOT NULL DEFAULT 'pending',
  output_path      TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clips_status ON clips(status) WHERE status IN ('pending', 'rendering');
CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status) WHERE status IN ('uploading', 'transcribing', 'transcribing-pending');

INSERT INTO templates (name, config)
SELECT
  'Default',
  '{
    "name": "Default",
    "caption": {
      "font_id": "builtin:verdana-bold-italic",
      "font_size": 64,
      "color": "#FFFFFF",
      "highlight_color": "#58604f",
      "italic": true,
      "max_chars_per_line": 18,
      "max_lines": 3,
      "position": "lower-third",
      "margin_v": 250,
      "outline_px": 4,
      "shadow_px": 0
    },
    "hook": {
      "font_id": "builtin:highest",
      "font_size": 88,
      "text_color": "#FFFFFF",
      "pill_color": "#7d8a72d9",
      "position_y_pct": 57.8
    },
    "output": {
      "aspect": "9:16",
      "crf": 20,
      "width": 1080,
      "height": 1920
    }
  }'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM templates);
