# Narration

`lines.json` holds the spoken line for each step in English and Arabic, with
the voice and speed used. The Arabic is fully vowelled on purpose: the
synthesiser reads unvowelled text badly.

```bash
apt-get install espeak-ng mbrola mbrola-en1          # once
python3 - <<'PY'
import json, subprocess
cfg = json.load(open('docs/guides/voice/lines.json', encoding='utf-8'))
dur = {}
for lang, c in cfg.items():
    dur[lang] = {}
    for key, text in c['lines'].items():
        out = f'docs/guides/voice/{lang}-{key}.wav'
        subprocess.run(['espeak-ng', '-v', c['voice'], '-s', str(c['speed']), '-p', '40', '-a', '170', '-w', out, text], check=True)
        dur[lang][key] = float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0', out]))
json.dump(dur, open('docs/guides/voice/durations.json', 'w'), indent=1)
PY
NODE_PATH=node_modules node docs/guides/video.js en   # paces each step to its line, logs cue times
NODE_PATH=node_modules node docs/guides/video.js ar
python3 docs/guides/mix.py en                          # -> ACA-How-to-Book-EN.mp4
python3 docs/guides/mix.py ar                          # -> ACA-How-to-Book-AR.mp4
```

The voices are espeak-ng's (mbrola en1 for English, the built-in Arabic
voice - the mbrola Arabic voices drop the letter ر). They are intelligible,
not natural. To use a neural voice instead, drop better WAVs in with the same
names and rerun from the durations step; the recorder and the mix do not care
where the audio came from.
