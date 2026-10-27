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
