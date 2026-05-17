#!/usr/bin/env python3
"""
Given a caption (the short-form caption that went viral) and a timestamped SRT
of the source long-form video, locate the viral moment and propose story-arc
in/out timestamps for a 3-4 minute horizontal cut.

CLI:
    python locate_moment.py --srt video.srt --caption "the IG/TikTok caption text"
    # prints JSON: {"in": "HH:MM:SS", "out": "HH:MM:SS", "duration_sec": int, "match_phrase": str, "confidence": float}

Module:
    from locate_moment import locate
    result = locate(srt_path, caption_text)
"""
import argparse
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path


STOPWORDS = {
    "the","a","an","is","are","of","to","and","in","that","this","it","on","for","with",
    "we","you","i","they","he","she","at","by","but","or","not","so","be","as","was",
    "have","has","had","do","does","did","will","would","can","could","should","my",
    "your","our","their","one","two","when","what","why","how","there","just","like",
    "now","get","got","really","up","out","about","from","know","said","says","into",
    "back","over","never","then","ever","also","more","most","much","because","if","all",
    "comment","dm","episode","conversation","watch","full","youtube","link","bio",
    "yes","okay","ok","go","want","need","ll",
}

BOILERPLATE = re.compile(
    r"(comment\s*[\"'‘’“”][^\"'‘’“”]+[\"'‘’“”]\s+and\s+(i|we)['’]?ll\s+dm[^.!?]*[.!?]?)|"
    r"(watch\s+the\s+full\s+episode[^.!?]*)|"
    r"(full\s+conversation\s+on\s+youtube[^.!?]*)|"
    r"(link\s+in\s+(my|our)?\s*bio[^.!?]*)|"
    r"(https?://\S+)",
    re.I,
)


def parse_srt(path: Path):
    """Return list of (start_sec, end_sec, text) tuples. Collapses consecutive duplicates."""
    raw = Path(path).read_text(encoding="utf-8", errors="replace")
    entries = []
    for block in raw.split("\n\n"):
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue
        m = re.match(
            r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)",
            lines[1],
        )
        if not m:
            continue
        sh, sm, ss, sms, eh, em, es, ems = (int(x) for x in m.groups())
        start = sh * 3600 + sm * 60 + ss + sms / 1000
        end = eh * 3600 + em * 60 + es + ems / 1000
        text = " ".join(lines[2:]).strip()
        entries.append((start, end, text))
    deduped, last = [], None
    for e in entries:
        if e[2] != last:
            deduped.append(e)
            last = e[2]
    return deduped


def _strip_boilerplate(text: str) -> str:
    return BOILERPLATE.sub(" ", text)


def extract_phrases(caption: str) -> list[tuple[str, float]]:
    """Pull distinctive multi-word phrases. Returns [(phrase, weight)] tuples.

    Weights:
      quoted phrases   2.0  (most distinctive — direct quotes survive auto-captioning)
      numbers / $      1.5  (specific, rare)
      proper nouns     0.4  (guest names appear throughout episode, low specificity)
    """
    if not caption:
        return []
    cleaned = _strip_boilerplate(caption)
    out: list[tuple[str, float]] = []
    seen: set[str] = set()

    for q in re.findall(r'[\"“”\'‘’]([^\"“”\'‘’]{6,80})[\"“”\'‘’]', cleaned):
        q = q.strip()
        if len(q.split()) >= 2 and q.lower() not in seen:
            out.append((q, 2.0)); seen.add(q.lower())

    for n in re.findall(r"(\$\d[\d,]*(?:\.\d+)?\s*(?:million|billion|m|k|b)?|\d{4}\b)", cleaned, re.I):
        if n.lower() not in seen:
            out.append((n, 1.5)); seen.add(n.lower())

    for p in re.findall(r"\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})\b", cleaned):
        if len(p.split()) >= 2 and p.lower() not in seen:
            out.append((p, 0.4)); seen.add(p.lower())

    return out


def extract_keywords(caption: str) -> list[str]:
    """Distinctive content words + bigrams for bag-of-words fallback matching."""
    cleaned = _strip_boilerplate(caption).lower()
    words = re.findall(r"\b[a-z][a-z'-]{3,}\b", cleaned)
    filtered = [w for w in words if w not in STOPWORDS]
    bigrams = [f"{filtered[i]} {filtered[i+1]}" for i in range(len(filtered) - 1)]
    singles = [w for w in filtered if len(w) >= 5]
    return list(dict.fromkeys(bigrams + singles))


def _fuzzy_find(entries, phrase: str, min_ratio: float = 0.7):
    p = phrase.lower().strip()
    if not p:
        return None, 0.0
    for i, (_, _, t) in enumerate(entries):
        if p in t.lower():
            return i, 1.0
    best, score = None, 0.0
    for i, (_, _, t) in enumerate(entries):
        s = SequenceMatcher(None, p, t.lower()).ratio()
        if s > score:
            score, best = s, i
    return (best, score) if score >= min_ratio else (None, score)


def _find_by_keyword_density(entries, caption: str, window_sec: float = 90):
    keywords = set(extract_keywords(caption))
    if not keywords:
        return None, 0
    entry_kw = []
    for i, (_, _, t) in enumerate(entries):
        toks = re.findall(r"\b[a-z][a-z'-]{3,}\b", t.lower())
        words = set(toks) | {f"{toks[j]} {toks[j+1]}" for j in range(len(toks) - 1)}
        entry_kw.append((i, words & keywords))
    best_idx, best_score = None, 0
    for center_i, _ in entry_kw:
        center_t = entries[center_i][0]
        hits = set()
        for i, kws in entry_kw:
            if abs(entries[i][0] - center_t) <= window_sec:
                hits |= kws
        if len(hits) > best_score:
            best_score = len(hits)
            best_idx = center_i
    return (best_idx, best_score) if best_score >= 3 else (None, best_score)


def _find_moment(entries, caption: str):
    """Return (center_index, anchor_phrase, confidence).

    Runs BOTH phrase-match and keyword-density scorers and picks the higher score.
    Quote phrases weighted 2.0, numbers 1.5, proper nouns only 0.4 (names appear
    throughout an episode and are low-specificity signals).
    """
    weighted_phrases = extract_phrases(caption)
    hits: list[tuple[int, float, float, str]] = []
    for phrase, weight in weighted_phrases:
        idx, score = _fuzzy_find(entries, phrase)
        if idx is not None:
            hits.append((idx, score, weight, phrase))

    phrase_best = None
    phrase_score = 0.0
    if hits:
        for anchor in hits:
            anchor_t = entries[anchor[0]][0]
            group = [h for h in hits if abs(entries[h[0]][0] - anchor_t) <= 90]
            has_quote = any(h[2] >= 2.0 for h in group)
            gscore = sum(h[1] * h[2] for h in group) + len(group) * 0.3
            if has_quote:
                gscore += 1.0
            if gscore > phrase_score:
                phrase_score = gscore
                phrase_best = group
    phrase_result = None
    if phrase_best:
        group_sorted = sorted(phrase_best, key=lambda h: -h[2])
        idxs = sorted(h[0] for h in phrase_best)
        phrase_result = (idxs[len(idxs) // 2], group_sorted[0][3], phrase_score)

    kw_idx, kw_count = _find_by_keyword_density(entries, caption)
    kw_result = None
    if kw_idx is not None:
        kw_score = kw_count / 2.0
        kw_result = (kw_idx, f"kw-density ({kw_count} keywords)", kw_score)

    candidates = [r for r in (phrase_result, kw_result) if r is not None]
    if not candidates:
        return None, "", 0.0
    candidates.sort(key=lambda r: -r[2])
    best = candidates[0]
    return best[0], best[1], min(1.0, best[2] / 4)


def _propose_in_out(entries, center_idx: int, target_min_sec: float = 180, target_max_sec: float = 270):
    """Walk outward for story-arc in/out boundaries."""
    center_t = entries[center_idx][0]
    pivot_candidates = [
        (i, e) for i, e in enumerate(entries)
        if center_t - 100 <= e[0] <= center_t - 30
    ]
    in_idx = None
    for i, (_, _, t) in pivot_candidates:
        if "?" in t or re.match(r"^(can you|what|why|how|tell me|i want to|do you)", t.strip(), re.I):
            in_idx = i
    if in_idx is None and pivot_candidates:
        in_idx = pivot_candidates[0][0]

    landing_candidates = [
        (i, e) for i, e in enumerate(entries)
        if center_t + 60 <= e[0] <= center_t + 180
    ]
    out_idx = None
    for i, (_, _, t) in landing_candidates:
        if re.search(
            r"\b(literally|fundamentally|important|matters|that's why|the lesson|"
            r"the truth|the bottom line|the point is)\b",
            t, re.I,
        ):
            out_idx = i
    if out_idx is None and landing_candidates:
        out_idx = landing_candidates[len(landing_candidates) // 2][0]

    in_t = entries[in_idx][0] if in_idx is not None else max(0, center_t - 60)
    out_t = entries[out_idx][1] if out_idx is not None else center_t + 120

    if out_t - in_t < target_min_sec:
        out_t = in_t + target_min_sec + 30
    if out_t - in_t > target_max_sec:
        out_t = in_t + target_max_sec

    return in_t, out_t


def _hms(s: float) -> str:
    return f"{int(s // 3600):02d}:{int(s % 3600 // 60):02d}:{int(s % 60):02d}"


def locate(srt_path: str | Path, caption: str, min_sec: float = 360, max_sec: float = 600) -> dict:
    """Locate the viral moment and propose story-arc in/out.

    Returns dict with keys:
      in, out                — "HH:MM:SS" strings
      in_sec, out_sec        — float seconds
      duration_sec           — int
      match_phrase           — what the matcher locked onto
      confidence             — 0.0 to 1.0
    """
    entries = parse_srt(srt_path)
    if not entries:
        return {"error": "empty or unparseable SRT"}
    center, phrase, confidence = _find_moment(entries, caption)
    if center is None:
        return {"error": "no match", "confidence": 0.0}
    in_t, out_t = _propose_in_out(entries, center, target_min_sec=min_sec, target_max_sec=max_sec)
    return {
        "in": _hms(in_t),
        "out": _hms(out_t),
        "in_sec": in_t,
        "out_sec": out_t,
        "duration_sec": int(out_t - in_t),
        "match_phrase": phrase,
        "confidence": round(confidence, 2),
    }


def main():
    ap = argparse.ArgumentParser(description="Locate viral moment in SRT given a caption")
    ap.add_argument("--srt", required=True, help="Path to source .srt file")
    ap.add_argument("--caption", required=True, help="The viral short-form caption text")
    ap.add_argument("--min-sec", type=float, default=360, help="Minimum clip duration in seconds (default 360 = 6 min)")
    ap.add_argument("--max-sec", type=float, default=600, help="Maximum clip duration in seconds (default 600 = 10 min)")
    args = ap.parse_args()
    result = locate(args.srt, args.caption, min_sec=args.min_sec, max_sec=args.max_sec)
    print(json.dumps(result, indent=2))
    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
