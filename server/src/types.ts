export type Word = {
  start: number;
  end: number;
  text: string;
};

export type Template = {
  id: string;
  name: string;
  caption: {
    font_id: string;
    font_size: number;
    color: string;
    highlight_color: string;
    italic: boolean;
    max_chars_per_line: number;
    max_lines: number;
    position: 'upper-third' | 'center' | 'lower-third';
    margin_v: number;
    outline_px: number;
    shadow_px: number;
  };
  hook: {
    font_id: string;
    font_size: number;
    text_color: string;
    pill_color: string;
    position_y_pct: number;
  };
  output: {
    aspect: '9:16' | '1:1' | '16:9';
    crf: number;
    width: number;
    height: number;
  };
  watermark?: {
    png_id: string;
    position: 'bottom-center' | 'bottom-right' | 'top-right';
    opacity: number;
  };
  fonts?: Array<{
    font_id: string;
    name: string;
  }>;
};

export type Source = {
  id: string;
  filename: string;
  duration: number | null;
  status: 'uploading' | 'transcribing-pending' | 'transcribing' | 'ready' | 'failed';
  words?: Word[];
  error?: string | null;
  created_at: string;
};

export type Clip = {
  id: string;
  source_id: string;
  template_id: string | null;
  in: number;
  out: number;
  hook_text: string;
  hook_visible: { start: number; end: number } | null;
  clip_type?: 'short' | 'youtube_long';
  signal_caption?: string | null;
  suggested_titles?: string[] | null;
  status: 'pending' | 'rendering' | 'done' | 'failed';
  output_url?: string;
  error?: string | null;
  created_at: string;
  updated_at?: string;
  spec?: Template;
};

export type FontRow = {
  id: number;
  template_id: number;
  name: string;
  filename: string;
  storage_path: string;
  created_at: string;
};

export type TemplateRow = {
  id: number;
  name: string;
  config: Omit<Template, 'id' | 'fonts'>;
  created_at: string;
  updated_at: string;
};

export type SourceRow = {
  id: number;
  filename: string;
  storage_path: string;
  duration: number | null;
  status: Source['status'];
  words: Word[] | null;
  error: string | null;
  created_at: string;
};

export type ClipRow = {
  id: number;
  source_id: number;
  template_id: number | null;
  in_seconds: number;
  out_seconds: number;
  hook_text: string | null;
  hook_visible: { start: number; end: number } | null;
  spec: Omit<Template, 'id' | 'fonts'> | null;
  clip_type: 'short' | 'youtube_long';
  signal_caption: string | null;
  suggested_titles: string[] | null;
  status: Clip['status'];
  output_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateClipPayload = {
  source_id: string;
  template_id: string;
  in: number;
  out: number;
  hook_text: string;
  hook_visible?: { start: number; end: number };
  aspect?: '9:16' | '1:1' | '16:9';
};
