import json, sys

src = sys.argv[1]
dst = sys.argv[2]
max_chars      = int(sys.argv[3])
max_lines      = int(sys.argv[4])
font_name      = sys.argv[5]
font_size      = int(sys.argv[6])
color_bgr      = sys.argv[7]
highlight_bgr  = sys.argv[8]
italic         = sys.argv[9]
margin_v       = int(sys.argv[10])
spacing        = float(sys.argv[11]) if len(sys.argv) > 11 else 0
line_spacing   = float(sys.argv[12]) if len(sys.argv) > 12 else 1.3

data = json.load(open(src))
words = data["words"]

chunks, cur_lines = [], [[]]
def line_len(idx_list):
    if not idx_list: return 0
    return sum(len(words[i]["text"]) for i in idx_list) + (len(idx_list) - 1)

for idx, w in enumerate(words):
    proposed = line_len(cur_lines[-1]) + (1 if cur_lines[-1] else 0) + len(w["text"])
    if proposed <= max_chars:
        cur_lines[-1].append(idx)
    elif len(cur_lines) < max_lines:
        cur_lines.append([idx])
    else:
        chunks.append(cur_lines)
        cur_lines = [[idx]]
chunks.append(cur_lines)

def fmt(t):
    return f"{int(t//3600)}:{int((t%3600)//60):02d}:{(t - int(t//60)*60):05.2f}"

header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{font_name},{font_size},{color_bgr},&H000000FF,&H00000000,&H00000000,0,{italic},0,0,100,100,{spacing},0,1,4,0,2,40,40,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

events = []
HL  = "{\\c" + highlight_bgr + "}"
RST = "{\\r}"

# Pixel distance between line baselines. Keep this tight, but never tighter
# than the visible font box or multi-line captions will collide.
line_height_px = max(font_size * line_spacing, font_size * 1.05)
# Bottom of the text block (same as libass default with \an2 + margin_v)
base_y = 1920 - margin_v

for chunk in chunks:
    flat = [i for line in chunk for i in line]
    if not flat: continue
    num_lines = len(chunk)

    for active in flat:
        ws = max(words[active]["start"], words[flat[0]]["start"])
        we = max(words[active]["end"], ws + 0.05)

        # Emit one positioned event per visual line
        for line_idx, line in enumerate(chunk):
            # line_idx 0 = top line, num_lines-1 = bottom line
            lines_above_bottom = num_lines - 1 - line_idx
            y_pos = int(base_y - lines_above_bottom * line_height_px)
            parts = [f"{HL}{words[i]['text']}{RST}" if i == active else words[i]["text"] for i in line]
            line_text = " ".join(parts)
            pos_tag = "{\\an2\\pos(540," + str(y_pos) + ")}"
            events.append(f"Dialogue: 0,{fmt(ws)},{fmt(we)},Cap,,0,0,0,,{pos_tag}{line_text}")

open(dst, "w").write(header + "\n".join(events) + "\n")
