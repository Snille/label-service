# Label service

A small LAN print service for DYMO LabelWriter printers. It is the **only** program that talks to the printers. Other systems send label content to its HTTP API; the service lays the label out from a template, shows a preview, and submits exactly one copy through CUPS. Label Studio (a separate web app) designs the templates.

Status: `VERSION` 0.8.0. Version 0.5 is live: it replaced the renderer and added saved templates and several printers, and Label Studio designs and prints its templates. 0.6 adds barcodes, 2D codes and dates; 0.7 deletes templates that were never published; 0.8 adds pictures (see [history](docs/HISTORY.md)).

## Why one owner

Reading the loaded roll briefly reserves the printer. Two programs that each talk to the printer can collide, and neither can stop the other. This service serializes roll reading and printing per printer, keeps one journal, and refuses to read the roll while CUPS has jobs.

## Stack

| Container | Purpose | Port |
| --- | --- | --- |
| `cups` | CUPS 2.4 on Ubuntu 24.04 with the official DYMO LW5xx driver (`raster2dymolw_v2`, built from a pinned, checksum-verified commit) for the LabelWriter 550, 550 Turbo and 5XL, and the CUPS DYMO driver (`printer-driver-dymo`) for the LabelWriter 450 and 4XL. One queue, created from the environment at start. | 631, stack network only |
| `api` | Node 24 HTTP API. SQLite journal, settings and templates in `/data`. `rsvg-convert` (librsvg) renders the PDF for CUPS and PNG previews. | 3230 |

CUPS sends jobs straight to the printer (`socket://PRINTER_HOST:9100`, or `PRINTER_URI` for a USB printer passed into the container). The roll reader in `api` also connects to the printer, only when an admin asks for it.

## Rendering

A label is one SVG drawing. The layout engine measures text with the real glyph metrics of the shipped fonts (`fonts/`, open licences) and draws it as outlines, so the preview, the PNG and the printed page have exactly the same shapes. The same drawing becomes the PDF that CUPS prints; a chosen text direction turns it a quarter turn onto the label. Fonts: Liberation Sans (regular, bold, italic, bold italic), Liberation Serif, Liberation Mono and DejaVu Sans Condensed (regular and bold). A character that a font lacks is refused rather than printed as a box.

Barcodes (Code 128, EAN-13) and 2D codes (QR, Data Matrix) are encoded with `bwip-js` and drawn by the layout as rectangles in whole printer dots (300 dpi): linear bars are at least two dots wide, 2D modules at least three, so codes print sharp. A box too small for that is a fit problem, not a blurred code.

Pictures (PNG, JPEG or SVG, at most 2 MB) are uploaded once and stored as PNG in the database; `rsvg-convert` turns JPEG and SVG into PNG (an SVG 1600 pixels wide) and never loads files or addresses an SVG points to. On a label the picture is resampled to whole printer dots and made black and white with a threshold or with Floyd-Steinberg dithering, so the preview shows the exact dots that print.

The npm dependencies are `opentype.js` (MIT), which reads the fonts, and `bwip-js` (MIT), which encodes the codes.

## Printers

Settings hold one CUPS server and one or more printers. Each printer has an id, a name, a model, a CUPS queue, its own loaded roll and text styles, and an optional roll reader. Jobs, roll reading and the busy lock are per printer.

| Model | Driver | Formats | Roll reading | Connection |
| --- | --- | --- | --- | --- |
| LabelWriter 5XL | LW5xx | all five | yes | network or USB |
| LabelWriter 550 Turbo | LW5xx | the four narrow formats | yes | network or USB |
| LabelWriter 550 | LW5xx | the four narrow formats | yes (network only) | USB |
| LabelWriter 450 | CUPS DYMO | the four narrow formats | no | USB |
| LabelWriter 4XL | CUPS DYMO | all five | no | USB |

The environment creates the first printer (`PRINTER_MODEL`, `CUPS_QUEUE`, `PRINTER_HOST`). Adding more printers through the admin page, and their CUPS queues, is planned for a later version; the settings model already supports them.

## Run locally (Docker Desktop)

```powershell
$env:LABEL_ADMIN_KEY = 'development-admin-key'
$env:LABEL_CLIENT_KEYS = 'storagesystem=development-storage-key'
$env:PRINTER_HOST = '<printer address>'
docker compose up -d --build
```

The API listens on `127.0.0.1:3230`. The development keys above are for local use only. Without `PRINTER_HOST`, CUPS starts without a queue. Do not run a development stack against a printer that a live service also uses.

## Configuration

| Variable | Meaning |
| --- | --- |
| `LABEL_ADMIN_KEY` | Admin key: settings, roll reading, all jobs, templates. Also acts as client `admin` with the designer role. |
| `LABEL_CLIENT_KEYS` | `name=key,name2=key2`. One key per calling system, at least 16 characters, lower-case names. |
| `LABEL_CLIENT_ROLES` | `name=designer,name2=drafter`. Designers (Label Studio) create, publish and test-print templates; drafters (an MCP tool) only save drafts. Others are plain clients. |
| `LABEL_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the API. Empty means server-to-server only. |
| `PRINTER_MODEL`, `PRINTER_NAME` | The first printer's model (`lw5xl`, `lw550t`, `lw550`, `lw450`, `lw4xl`) and display name. |
| `PRINTER_HOST`, `PRINTER_PORT` | The first printer on the LAN (port 9100). |
| `PRINTER_URI` | CUPS only: a device URI instead of `PRINTER_HOST`, for example a USB printer. |
| `CUPS_QUEUE` | Queue name, default `DYMO_5XL`. |
| `LABEL_DB` | SQLite file, `/data/label-service.sqlite` in Docker. |
| `RSVG_CONVERT` | Path to `rsvg-convert`, if it is not on `PATH`. |
| `TZ` | Time zone for date objects, `Europe/Stockholm` in the stack files. |

The environment sets the first settings. After an admin saves settings through the API, the saved settings apply. Settings saved by 0.4 become the default printer on first read.

## Admin page

Open the service in a browser and enter the admin key. The page shows the CUPS queue of the chosen printer, reads the loaded roll (`Use the detected format` selects it), sets the selected format and each format's text direction and sizes, sets the batch limit, previews and prints one test label, and lists recent jobs. The key stays in the tab's memory only.

## API

Send the key as `x-api-key: <key>` or `Authorization: Bearer <key>`. Bodies are JSON (max 256 KB; 3 MB for a picture upload). `?printer=<id>` picks a printer where noted; without it the default printer applies.

| Method and path | Who | Purpose |
| --- | --- | --- |
| `GET /healthz` | anyone | Liveness and version. |
| `GET /api/v1/formats[?printer=]` | client | The printer's selected format (the loaded roll), its text style, the formats its model supports, the printers, the fonts. |
| `GET /api/v1/status[?printer=]` | client | CUPS queue state from IPP attributes. Never contacts the printer. |
| `GET /api/v1/templates` | client | Built-in kinds and saved templates (published ones; designers and drafters also see the latest draft, `archived` when every version is archived and `everPublished`). |
| `GET /api/v1/templates/<id>[?version=n]` | client | One template with its definition. Plain clients see published versions only. |
| `GET /api/v1/templates/<id>/versions` | designer, drafter | All versions with their status. |
| `POST /api/v1/templates` | designer, drafter | `{definition}` → a new draft version (1, 2, ...). |
| `POST /api/v1/templates/<id>/versions/<n>/publish`, `.../archive` | designer | Publish or archive one version. |
| `DELETE /api/v1/templates/<id>` | designer | Delete every version of a template that was never published (409 otherwise: archive it instead). |
| `GET /api/v1/assets`, `POST /api/v1/assets` | designer, drafter | List pictures; upload `{name, data}` with the picture as base64 → `{id, name, type, width, height, bytes, createdAt, createdBy}`. |
| `GET /api/v1/assets/<id>/content` | designer, drafter | The stored PNG. |
| `DELETE /api/v1/assets/<id>` | designer | Delete a picture that no saved template uses (409 names the templates otherwise). |
| `POST /api/v1/previews` | client | See below → `{token, expiresAt, kind, template?, printer, layout, svg, png?, printable, warnings}`. Nothing prints. |
| `POST /api/v1/jobs` | client | `{token, requestId}` (UUIDs) → the journal record. Prints one copy. |
| `GET /api/v1/jobs`, `GET /api/v1/jobs/<requestId>` | client (own) / admin (all) | Journal records, with live CUPS job state for one job. |
| `GET`, `PUT /api/v1/settings` | admin | `{revision, config}`: `serverUrl`, `defaultPrinter`, `batchLimit` and `printers`. |
| `POST /api/v1/roll` | admin | `{revision, printer?}`. Reads the loaded roll once; needs an idle, empty queue. |

Preview request: `{kind? | template?, version?, fields | test: true, printer?, mediaKey?, orientation?: 'portrait'|'landscape', reference?, include?: ['png']}`.

- `kind` is a built-in template: `box` (`title`, `description`, `location`), `location` (only `location`, printed large) or `lines` (`{lines: [{text, bold?, size?}]}`, 1-12 lines, 6-16 points, shrunk together until they fit; an empty `text` is a spacer).
- `template` is a saved template id (the latest published version unless `version` is given), or, for designers and drafters, a whole unsaved definition.
- `warnings` lists what stops printing, per object: `{object, message}`, for example `"recipient" needs 4 rows, but 3 fit at 7 pt`. `layout.lines` keeps the original row list (text, centre x, baseline y, size, bold, width) for clients that draw their own preview.
- `include: ['png']` adds a 300 dpi PNG of the label (base64).

`orientation` sets the text direction for this one label; without it, the template's direction or the selected format's saved direction applies.

## Templates

A template places objects on the readable label. Lengths are millimetres or percentages of the label side; each axis takes two of start, end and size (`x`/`right`/`w`, `y`/`bottom`/`h`). Text uses `{{field}}` placeholders.

```json
{
  "id": "shipping-small", "name": "Fraktetikett liten", "media": ["w154h286"], "orientation": "portrait",
  "fields": {
    "recipient": { "type": "text", "maxLength": 200, "multiline": true },
    "orderNo": { "type": "text", "pattern": "^[0-9]{6,10}$", "required": false }
  },
  "objects": [
    { "type": "rect", "x": 2, "y": 2, "right": 2, "h": 12, "stroke": 0.4, "radius": 1.5 },
    { "id": "recipient", "type": "text", "x": 4, "y": 16, "right": 4, "h": 30, "text": "{{recipient}}", "font": "Liberation Serif", "size": 12, "minSize": 7, "align": "left" },
    { "type": "line", "x": 2, "y": 48, "right": 2, "h": 0, "dash": [1, 0.5] },
    { "type": "text", "x": 4, "y": "55%", "w": "50%", "h": 6, "text": "Order {{orderNo}}", "font": "Liberation Mono", "bold": true, "size": 9 }
  ]
}
```

- `media`: the formats the template is made for, or `["*"]`. A preview on another roll is refused.
- Fields: `text` (`required`, `maxLength` up to 2000, `multiline`, `pattern`, `label`, `sample`) and `lines` (`maxItems` up to 50).
- Objects: `text` (`font`, `size` in points or a format size such as `"$titleSize"`, `minSize` to shrink to, `bold`, `italic`, `wrap`, `breakHyphens`, `align`, `valign`, `lineHeight`, `color` black or white), `stack` (free lines from a `lines` field), `line`, `rect` and `ellipse` (`stroke` in mm, `fill` none, black or white, `radius`, `dash`).
- `barcode`: `symbology` (`code128`, `ean13`, `qrcode`, `datamatrix`), `data` with `{{field}}` placeholders, `align` and `valign` inside the box. Linear codes fill the box width with whole-dot bars and take `humanReadable` (`below`, the default, or `none`) with `font` and `size` for the text; EAN-13 takes 12 digits (the check digit is added) or 13 with a correct check digit. QR codes take `ecLevel` (`L`, `M`, `Q`, `H`). Data that the symbology cannot encode is a fit problem with the reason.
- `date`: the date and time of the preview (a print uses its preview, so at most ten minutes old) in `format` (`yyyy`, `yy`, `MM`, `dd`, `HH`, `mm`; default `yyyy-MM-dd`), with optional `prefix` and `suffix` and the text properties.
- `image`: `asset` (an uploaded picture id), `fit` (`contain`, the default, keeps the proportions; `stretch` fills the box), `mode` (`threshold`, the default, or `dither` for photos and shades), `threshold` (1-254, default 128: darker is black), `invert`, `align` and `valign`. Transparent parts are white. A missing picture is a fit problem.
- Built-in and published templates print for every client. Drafts and unsaved designs print only with a designer key, so an LLM tool can propose but not print a template nobody has approved.

## Rules that protect the printer and the labels

- A preview belongs to the client that made it, lives ten minutes, and can create one job. Another client cannot use or see it.
- Anything that does not fit gives `printable: false` and a warning, and printing is refused.
- If `mediaKey` is sent and differs from the printer's selected format, the preview is refused. Change the roll and the format first.
- Reusing a `requestId` returns the existing record and never prints again. A lost response after submission is recorded as `unknown` and is not retried. Check the job and the label before preparing another.
- Each printer rests 10 seconds after a job and waits for an idle, empty CUPS queue before the next job: the DYMO driver refuses a job that arrives while the printer is still finishing the previous label (`com.dymo.busy-error`). A submission that waits longer than two minutes is refused with 429, never printed later.
- CUPS accepts any media name in `Validate-Job` (it even accepts sizes that do not exist), so the service's own format list is the real guard.

Formats: S0722540 (57 × 32 mm), S0722550 (19 × 51 mm), S0722520 (25 × 54 mm), S0722430 (54 × 101 mm) and shipping labels 2166659 (102 × 210 mm, a CUPS custom page size because `lw5xl.ppd` has no named size for it; wide models only). On 19 × 51 mm, a landscape box label does not fit with the default sizes; use a location label or smaller sizes. Each format keeps its own text sizes and text direction per printer (landscape along the long side, portrait across it).

## Portainer

Published images (Docker Hub, `linux/amd64`): `mrsnille/label-service` and `mrsnille/label-service-cups`, tagged with the version and `latest`. Deploy [compose.portainer.yaml](compose.portainer.yaml) as a stack; it uses the current release tags by default. Set these stack variables:

- `LABEL_ADMIN_KEY` and `LABEL_CLIENT_KEYS`: long random keys, one client key per calling system. Optional `LABEL_CLIENT_ROLES`.
- `PRINTER_HOST`: the printer's LAN address. Optional `PRINTER_MODEL` (default `lw5xl`) and `PRINTER_NAME`.
- Optional: `LABEL_BIND`, `LABEL_PORT`, `CUPS_QUEUE`, `LABEL_ALLOWED_ORIGINS`, or `LABEL_API_IMAGE` / `LABEL_CUPS_IMAGE` to pin a digest.

Publish port 3230 on the LAN only. Keep the volumes on local storage. To update, raise the image tags (or re-pull `latest`) and recreate the stack.

Release: bump `VERSION`, add a history entry, run the checks, then build and push both images:

```powershell
$v = Get-Content VERSION
docker buildx build --platform linux/amd64 -t mrsnille/label-service:$v -t mrsnille/label-service:latest --push .
docker buildx build --platform linux/amd64 -t mrsnille/label-service-cups:$v -t mrsnille/label-service-cups:latest --push ./cups
```

## Checks and data

```powershell
npm ci
npm run check          # syntax, tests, git whitespace
npm run audit:data     # journal, settings and template audit (LABEL_DB)
node src/cli.js backup <file>
node src/cli.js restore <backup> <new-database>
```

The Docker build runs the same tests, including the PDF and PNG conversion with `rsvg-convert` (skipped on a machine without it). Hardware checks that never print: `GET /api/v1/status`, previews, `Validate-Job`, and offline raster conversion with `cupsfilter -m application/vnd.cups-raster` inside the `cups` container. The DYMO filters need a live printer connection, so the last step can only be checked with a real print.
