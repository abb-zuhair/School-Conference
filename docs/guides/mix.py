#!/usr/bin/env python3
"""
Lay the spoken lines onto the recording at the moments the recorder logged,
and encode a phone-friendly MP4.

    python3 mix.py en   # -> ACA-How-to-Book-EN.mp4
    python3 mix.py ar   # -> ACA-How-to-Book-AR.mp4
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
lang = sys.argv[1] if len(sys.argv) > 1 else 'en'
cues = json.loads((HERE / 'voice' / f'cues-{lang}.json').read_text())
video = HERE / 'raw' / f'booking-{lang}.webm'
out = HERE / f'ACA-How-to-Book-{lang.upper()}.mp4'

inputs = ['-i', str(video)]
chains = []
labels = []
for i, c in enumerate(cues, start=1):
    wav = HERE / 'voice' / f'{lang}-{c["key"]}.wav'
    inputs += ['-i', str(wav)]
    delay_ms = int(round(c['t'] * 1000))
    # resample to one rate, soften the synthetic edge a little, place in time
    chains.append(
        f'[{i}:a]aresample=48000,highpass=f=90,lowpass=f=7000,volume=1.6,'
        f'adelay={delay_ms}|{delay_ms}[a{i}]'
    )
    labels.append(f'[a{i}]')

filter_complex = ';'.join(chains) + ';' + ''.join(labels) + \
    f'amix=inputs={len(labels)}:normalize=0:duration=longest,alimiter=limit=0.9,apad[a]'

cmd = [
    'ffmpeg', '-v', 'error', '-y', *inputs,
    '-filter_complex', filter_complex,
    '-map', '0:v', '-map', '[a]',
    '-vf', 'scale=1280:720:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-r', '25',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
    '-shortest', '-movflags', '+faststart',
    str(out),
]
subprocess.run(cmd, check=True)
probe = subprocess.check_output([
    'ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
    '-show_entries', 'format=duration,size', '-of', 'default=nw=1', str(out),
]).decode()
print(out.name)
print(probe)
