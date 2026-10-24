# History

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
