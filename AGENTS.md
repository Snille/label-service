# Project instructions

- Write code, comments, documentation, logs and commit messages in English.
- Read README.md and docs/HISTORY.md before changing behavior. Keep `VERSION` as the single version source and add a history entry for meaningful changes.
- This service is the only program that may talk to the DYMO printers, including roll reading. Never add a second path to the printer, automatic status polling, raw `ESC A 0` queries, feed or reset commands.
- Keep the guards: explicit preview, overflow blocking, one copy per job, durable request deduplication, `unknown` without retry after a lost response, and client-owned previews and jobs.
- Never submit a physical print as part of development or testing without the owner's explicit approval in chat. Use previews, `Validate-Job` and offline raster conversion instead.
- Test against isolated data. Do not commit runtime data, credentials or backups. Run `npm run check` before committing.
- Keep dependencies few and pinned (`opentype.js` reads the fonts; `bwip-js` is approved for barcodes). Text is drawn as outlines from `fonts/`, so preview and paper stay identical.
- Keep the repository free of LAN addresses, hostnames and secret locations; it is meant to become public. Deployment details live in the owner's notes.
