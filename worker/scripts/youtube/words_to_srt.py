#!/usr/bin/env python3
"""
Convert a Whisper word-level JSON array to SRT format.

Input JSON shape (from DB words column):
  [{"text": "Hello", "start": 0.0, "end": 0.4}, ...]

Usage:
  python words_to_srt.py words.json output.srt
  python words_to_srt.py words.json -  # write to stdout
"""
import json
import sys
from pathlib import Path


def fmt_ts(seconds: float) -> str:
    ms = max(0, round(seconds * 1000))
    h = ms // 3_600_000
    m = (ms % 3_600_000) // 60_000
    s = (ms % 60_000) // 1000
    millis = ms % 1000
    return f"{h:02d}:{m:02d}:{s:02d},{millis:03d}"


def words_to_srt(words: list[dict]) -> str:
    if not words:
        return ""

    sorted_words = sorted(
        [w for w in words if isinstance(w.get("text"), str)],
        key=lambda w: float(w.get("start", 0)),
    )

    blocks: list[tuple[float, float, str]] = []
    current: list[dict] = []

    def flush():
        if not current:
            return
        start = float(current[0].get("start", 0))
        end = float(current[-1].get("end", start))
        text = " ".join(w["text"] for w in current).strip()
        if text:
            blocks.append((start, end, text))
        current.clear()

    for word in sorted_words:
        start = float(word.get("start", 0))
        end = float(word.get("end", start))
        if current:
            block_start = float(current[0].get("start", 0))
            prev_end = float(current[-1].get("end", block_start))
            current_text = " ".join(w["text"] for w in current)
            should_break = (
                start - prev_end >= 0.8
                or end - block_start >= 4.5
                or len(current) >= 12
                or len(current_text) >= 72
            )
            if should_break:
                flush()
        current.append(word)

    flush()

    lines = []
    for i, (start, end, text) in enumerate(blocks, 1):
        lines.append(f"{i}\n{fmt_ts(start)} --> {fmt_ts(end)}\n{text}\n")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: words_to_srt.py <words.json> <output.srt|->\n")
    words = json.loads(Path(sys.argv[1]).read_text())
    srt = words_to_srt(words)
    if sys.argv[2] == "-":
        sys.stdout.write(srt)
    else:
        Path(sys.argv[2]).write_text(srt)


if __name__ == "__main__":
    main()
