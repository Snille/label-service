# History

## 0.1.0-dev - 2026-10-24

- New LAN label print service: the single owner of the DYMO LabelWriter 5XL. Other systems (first Storage System Base, later a label designer) send label content to its API instead of talking to CUPS or the printer.
- Ported the printing code that Storage System Base 0.14.0 had physically accepted: four article-backed formats, per-format text sizes and text direction, box and location labels, bounded IPP client, manual DYMO roll reading, preview tokens, overflow blocking, one copy, durable deduplication and the `unknown` state without retry.
- Added one API key per client system, client-owned previews and jobs, an admin key for settings and roll reading, an optional browser origin allow-list, a SQLite journal with audit, backup and restore.
- Added a CUPS container with the official DYMO LW5xx driver built from a pinned, checksum-verified source commit, matching the old server (Ubuntu 24.04, CUPS 2.4, `lw5xl.ppd`, `raster2dymolw_v2`). Build fixes: regenerate the stale autotools files, add `libboost-dev`, and include `<ctime>` for GCC 13.
- Verified in Docker Desktop: 22 tests pass in the image build; the stack starts healthy; CUPS reports the queue idle and accepting PostScript; previews work for all four formats in both directions; `Validate-Job` accepts the four media keys; offline conversion produces CUPS raster for all eight cases. No physical label has been printed through this service yet.
