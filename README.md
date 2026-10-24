# Label service

A small LAN print service for a DYMO LabelWriter 5XL. It is the **only** program that talks to the printer. Other systems send label content to its HTTP API; the service lays the label out, shows a preview, and submits exactly one copy through CUPS.

Status: development preview (`VERSION`), running in Docker Desktop. All five formats have been printed through this service in portrait and landscape and accepted by the owner (see [history](docs/HISTORY.md)). Not yet deployed to Portainer, and no client system uses it yet.

## Why one owner

Reading the loaded roll briefly reserves the printer. Two programs that each talk to the printer can collide, and neither can stop the other. This service serializes roll reading and printing, keeps one journal, and refuses to read the roll while CUPS has jobs.

## Stack

| Container | Purpose | Port |
| --- | --- | --- |
| `cups` | CUPS 2.4 on Ubuntu 24.04 with the official DYMO LW5xx driver (`lw5xl.ppd`, `raster2dymolw_v2`), built from a pinned, checksum-verified commit. One queue, created from the environment at start. | 631, stack network only |
| `api` | Node 24 HTTP API, no external packages. SQLite journal and settings in `/data`. | 3230 |

CUPS sends jobs straight to the printer (`socket://PRINTER_HOST:9100`). The roll reader in `api` also connects to `PRINTER_HOST:9100`, only when an admin asks for it.

## Run locally (Docker Desktop)

```powershell
$env:LABEL_ADMIN_KEY = 'development-admin-key'
$env:LABEL_CLIENT_KEYS = 'storagesystem=development-storage-key'
$env:PRINTER_HOST = '<printer address>'
docker compose up -d --build
```

The API listens on `127.0.0.1:3230`. The development keys above are for local use only. Without `PRINTER_HOST`, CUPS starts without a queue.

## Configuration

| Variable | Meaning |
| --- | --- |
| `LABEL_ADMIN_KEY` | Admin key: settings, roll reading, all jobs. Also acts as client `admin`. |
| `LABEL_CLIENT_KEYS` | `name=key,name2=key2`. One key per calling system, at least 16 characters, lower-case names. |
| `LABEL_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the API. Empty means server-to-server only. |
| `PRINTER_HOST`, `PRINTER_PORT` | The printer on the LAN (port 9100). |
| `CUPS_QUEUE` | Queue name, default `DYMO_5XL`. |
| `LABEL_DB` | SQLite file, `/data/label-service.sqlite` in Docker. |

The environment sets the first CUPS and roll-reader settings. After an admin saves settings through the API, the saved settings apply.

## API

Send the key as `x-api-key: <key>` or `Authorization: Bearer <key>`. Bodies are JSON (max 64 KB).

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /healthz` | anyone | Liveness and version. |
| `GET /api/v1/formats` | client | Selected format (the loaded roll), its text style, all formats and label kinds. |
| `GET /api/v1/status` | client | CUPS queue state from IPP attributes. Never contacts the printer. |
| `POST /api/v1/previews` | client | `{kind?: 'box'\|'location', fields \| test: true, mediaKey?, reference?}` → `{token, expiresAt, layout, svg, printable}`. Nothing prints. |
| `POST /api/v1/jobs` | client | `{token, requestId}` (UUIDs) → the journal record. Prints one copy. |
| `GET /api/v1/jobs`, `GET /api/v1/jobs/<requestId>` | client (own) / admin (all) | Journal records, with live CUPS job state for one job. |
| `GET`, `PUT /api/v1/settings` | admin | `{revision, config}` with CUPS origin, queue, selected format, per-format `styles` and `rollReader`. |
| `POST /api/v1/roll` | admin | `{revision}`. Reads the loaded roll once; needs an idle, empty queue. |

Label kinds: `box` takes `title`, `description` and `location`; `location` takes only `location` and prints it large. Text must be Latin-1 (Swedish letters work).

Rules that protect the printer and the labels:

- A preview belongs to the client that made it, lives ten minutes, and can create one job. Another client cannot use or see it.
- Text that does not fit gives `printable: false`, and printing is refused.
- If `mediaKey` is sent and differs from the selected format, the preview is refused. Change the roll and the format first.
- Reusing a `requestId` returns the existing record and never prints again. A lost response after submission is recorded as `unknown` and is not retried. Check the job and the label before preparing another.
- CUPS accepts any media name in `Validate-Job` (it even accepts sizes that do not exist), so the service's own format list is the real guard.

Formats: S0722540 (57 × 32 mm), S0722550 (19 × 51 mm), S0722520 (25 × 54 mm), S0722430 (54 × 101 mm) and shipping labels 2166659 (102 × 210 mm, a CUPS custom page size because `lw5xl.ppd` has no named size for it). On 19 × 51 mm, a landscape box label does not fit with the default sizes; use a location label or smaller sizes. Each format keeps its own text sizes and text direction (landscape along the long side, portrait across it).

## Portainer

Build and push both images (`.` and `./cups`) to a registry, then deploy [compose.portainer.yaml](compose.portainer.yaml) with immutable image tags, long random keys and `PRINTER_HOST`. Publish port 3230 on the LAN only. Keep the volumes on local storage. No image has been published yet.

## Checks and data

```powershell
npm run check          # syntax, tests, git whitespace
npm run audit:data     # journal and settings audit (LABEL_DB)
node src/cli.js backup <file>
node src/cli.js restore <backup> <new-database>
```

The Docker build runs the same tests. Hardware checks that never print: `GET /api/v1/status`, previews, `Validate-Job`, and offline raster conversion with `cupsfilter -m application/vnd.cups-raster` inside the `cups` container. The DYMO filter itself needs a live printer connection, so the last step can only be checked with a real print.
