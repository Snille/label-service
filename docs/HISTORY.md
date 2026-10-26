# History

## 0.5.1 - 2026-10-26

- Fixed: an empty line between paragraphs in a text field disappeared, so paragraphs ran together in the preview and on paper. Text wrapping now keeps it as an empty row of the same height; empty lines before the first and after the last paragraph are still dropped. Text that used empty lines (for example a multi-line box description) can now need more rows. Found on paper with Label Studio on the 102 x 210 mm shipping roll; a test covers it.
- The Portainer stack file includes the Label Studio service.
- Paper tests on the live 5XL through Label Studio 0.1.1 (2026-10-26, checked by the owner): a name label on S0722540 (57 x 32 mm) and a text-heavy label on 2166659 (102 x 210 mm), both sharp, the right way round and unclipped.

## 0.5.0 - 2026-10-25

Phase 0 of Label Studio: the service can render any designed label, store templates and drive several printers.

- New renderer: a label is one SVG drawing. Text is measured with the real metrics of shipped open fonts (Liberation Sans, Serif and Mono, DejaVu Sans Condensed; `opentype.js`) and drawn as outlines, so preview, PNG and paper share the same shapes. `rsvg-convert` (librsvg, now in the api image) makes the PDF that CUPS prints and optional 300 dpi PNG previews (`include: ['png']`). The PostScript generator is removed; jobs are sent as `application/pdf`. Characters outside Latin-1 now work when the font has them; a missing glyph is refused.
- Template format v1: objects (`text`, `stack`, `line`, `rect`, `ellipse`) placed in millimetres or percentages, `{{field}}` placeholders, typed fields, per-object fit (shrink to a minimum size, wrap, hyphen breaks) and per-object warnings (`warnings: [{object, message}]`).
- Saved templates in SQLite (schema version 2, migrated automatically): versions are drafts, published or archived. New endpoints under `/api/v1/templates`. `LABEL_CLIENT_ROLES` gives keys the designer role (create, publish, test-print drafts) or the drafter role (drafts only); ordinary keys preview and print published templates.
- `box`, `location` and `lines` are now built-in templates in the new format. Their request format, `layout.lines` and journal kinds are unchanged, so Storage System Base needs no change. Positions match 0.4.1; descriptions may wrap one row earlier because real text is wider than the old estimate.
- Several printers: settings hold `printers` (id, name, model, queue, loaded roll, styles, roll reader), a default printer and a `batchLimit` (default 50, for the coming batch printing). Settings saved by 0.4 become the default printer. Previews, status and roll reading take a printer; jobs record it; the busy lock is per printer. Supported models: LabelWriter 5XL, 550 Turbo, 550, 450 and 4XL; only wide models get the 102 x 210 mm format, only 5xx models read the roll.
- CUPS image: adds `printer-driver-dymo` for the 450 and 4XL. `PRINTER_MODEL` picks the driver and `PRINTER_URI` allows a USB printer.
- Admin page: printer choice (when there is more than one), batch limit, printer column in the journal, readable fit warnings.
- Each printer rests 10 seconds after a job, and waits until its CUPS queue is idle and empty, before the next job is sent. In the paper test a second job sent 5 seconds after the first was refused by the DYMO driver (`com.dymo.busy-error`, the printer did not answer its status query) and never printed; with the pause both labels print. Roll reading also waits for the pause.
- The CUPS entrypoint retries `lpadmin`: cupsd sometimes answers `lpstat` before it accepts administration, and the container then stopped at start.
- Request bodies may be 256 KB. LAN addresses and deployment details moved out of the repository (they live in the owner's notes), so it can become public.
- Verified offline: CUPS raster from the new PDFs matches the accepted 0.4.1 PostScript pages in size for all formats and in placement within 0.7 mm, also rotated; the 450 queue accepts PDF. 35 tests (one needs librsvg and runs in the Docker build).
- Paper test on the 5XL with S0722540, through a short-lived local 0.5.0 stack while the live service was idle: the box test label printed correctly (owner-checked: sharp, right way round, unclipped, same placement). The rotated location label and a free-lines label then printed back to back through the new pause; both CUPS jobs completed without a busy error, and the owner confirmed both labels (rotated text, Unicode arrow and degree sign).

## 0.4.1 - 2026-10-25

- Favicon: a Da Vinci style sketch of a printing machine with a label tag, shared theme with the other services (made with the ComfyUI icon workflow in `Coding/Icons`). Served as `/favicon.ico`, `/favicon-32.png` and `/apple-touch-icon.png`; the HTTP test checks all three.

## 0.4.0 - 2026-10-24

- Clients may choose the text direction per label (`orientation` in the preview request); the format's saved direction is the default and is not changed.
- New free-lines template (`kind: 'lines'`) so any system can print its own text: 1-12 lines with optional bold and size, shrunk together to fit and centred; empty lines are spacers.
- `GET /api/v1/templates` lists the templates and their fields. The journal accepts the `lines` kind.
- The admin page can test free lines and either text direction.
- 29 tests pass.

## 0.3.0 - 2026-10-24

- Added an admin web page at `/`: queue status, manual roll reading with `Use the detected format`, selected format, per-format text direction and sizes, a test label preview (SVG) and one-copy test print, and the recent job journal. It asks for the admin key and keeps it in the tab's memory only; strict Content Security Policy, no inline script.
- The API now also accepts browser calls from the service's own origin, so the page works without `LABEL_ALLOWED_ORIGINS`.
- Printer settings now live only here. Storage System Base 0.15 prints through this service with a client key and no longer reads the roll or holds printer settings.

## 0.2.0 - 2026-10-24

- First published release: images `mrsnille/label-service:0.2.0` and `mrsnille/label-service-cups:0.2.0` (also `latest`) on Docker Hub for `linux/amd64`. `compose.portainer.yaml` uses these tags by default.
- Physical acceptance through this service (owner-confirmed legible, correctly facing, unclipped text and solid power after each roll), one portrait and one landscape label per format, each after reading the loaded roll:
  - S0722550 / 19 x 51 mm: CUPS jobs 1 (portrait box label) and 2 (landscape location label; a landscape box label does not fit with the default sizes and is blocked).
  - S0722520 / 25 x 54 mm: jobs 3 and 4. S0722430 / 54 x 101 mm: jobs 5 and 6. S0722540 / 57 x 32 mm: jobs 7 and 8.
  - New shipping format 2166659 / 102 x 210 mm: jobs 9 and 10.
- Added the shipping label format 2166659 (102 x 210 mm, size measured by the owner; the article number on the label backing matches the roll chip). `lw5xl.ppd` has no named size for it, so CUPS uses the PPD's custom page size through the PWG name `custom_102x210mm_102x210mm`. Offline raster conversion gives exactly 289 x 595 pt in both directions. Larger default text sizes (title 16, description 12, location 14).
- Roll reading accepts seven-digit articles without the `S` prefix (shipping labels).
- Settings saved before a format existed gain that format's defaults instead of becoming invalid.
- Fixed the CUPS queue: it must be shared (`printer-is-shared=true`, as on the old server), or CUPS refuses Print-Job from the api container with `client-error-not-authorized`. Browsing stays off. The first submission hit this and printed nothing; its journal entry remains `unknown` from the older code.
- A verified IPP error status (0x0400 and above) is now recorded as `rejected`, because CUPS created no job. Lost responses and success-with-warning statuses stay `unknown`.
- PostScript `%%BoundingBox` is always integer; fractional pages add `%%HiResBoundingBox`. Output for the four integer formats is unchanged.
- 25 tests pass. Once, after a roll change, the printer did not answer on the network until a label was fed by hand; the roll reader timed out without sending any command.

## 0.1.0-dev - 2026-10-24

- New LAN label print service: the single owner of the DYMO LabelWriter 5XL. Other systems (first Storage System Base, later a label designer) send label content to its API instead of talking to CUPS or the printer.
- Ported the printing code that Storage System Base 0.14.0 had physically accepted: four article-backed formats, per-format text sizes and text direction, box and location labels, bounded IPP client, manual DYMO roll reading, preview tokens, overflow blocking, one copy, durable deduplication and the `unknown` state without retry.
- Added one API key per client system, client-owned previews and jobs, an admin key for settings and roll reading, an optional browser origin allow-list, a SQLite journal with audit, backup and restore.
- Added a CUPS container with the official DYMO LW5xx driver built from a pinned, checksum-verified source commit, matching the old server (Ubuntu 24.04, CUPS 2.4, `lw5xl.ppd`, `raster2dymolw_v2`). Build fixes: regenerate the stale autotools files, add `libboost-dev`, and include `<ctime>` for GCC 13.
- Verified in Docker Desktop: 22 tests pass in the image build; the stack starts healthy; CUPS reports the queue idle and accepting PostScript; previews work for all four formats in both directions; `Validate-Job` accepts the four media keys; offline conversion produces CUPS raster for all eight cases. No physical label has been printed through this service yet.
