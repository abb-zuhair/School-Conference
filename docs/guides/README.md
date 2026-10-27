# Parent and teacher guides

The Word guides are generated, so a screenshot is never out of date for long.

```bash
npm run seed && npm start                 # a seeded app on :3000
npm run family                            # a few real bookings to show
node docs/guides/shots.js                 # screenshots into docs/guides/shots/
node docs/guides/shots-crops.js           # the tighter crops
node docs/guides/parent.js                # -> docs/guides/out/ACA-Appointments-Parent-Guide.docx
node docs/guides/teacher.js               # -> docs/guides/out/ACA-Appointments-Teacher-Guide.docx
```

`lib.js` holds the page style and the bilingual block the parent guide is
built from. Screenshots are taken at 2x and scaled in `shot()`. The scripts
need `playwright-core` and a Chromium; `docx` is a normal dependency.

The Arabic was written by the generator, not a native speaker. Have it read
once before it goes to parents.

## The parent video

`video.js` records the same booking flow with a visible cursor and a
bilingual caption bar, no sound - a parent can follow it on mute.

```bash
npm run seed && npm start
NODE_PATH=node_modules node docs/guides/video.js      # -> docs/guides/raw/booking.webm
ffmpeg -i docs/guides/raw/booking.webm -vf "scale=1280:720:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 20 -r 25 -movflags +faststart -an ACA-How-to-Book.mp4
```

Playwright's recorder needs an ffmpeg it recognises; if it complains, point
`/opt/pw-browsers/ffmpeg-<n>/ffmpeg-linux` at the system ffmpeg. The capture
is taken at 960x540 (Playwright pads rather than enlarges) and scaled to 720p
in the encode.
