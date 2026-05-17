import sys, json
from faster_whisper import WhisperModel

audio_path, out_path, model_name = sys.argv[1], sys.argv[2], sys.argv[3]
model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, info = model.transcribe(audio_path, word_timestamps=True, vad_filter=True)

words = []
for seg in segments:
    for w in (seg.words or []):
        words.append({
            "start": round(w.start, 3),
            "end":   round(w.end, 3),
            "text":  w.word.strip(),
        })

json.dump({"language": info.language, "duration": info.duration, "words": words},
          open(out_path, "w"), indent=2)
