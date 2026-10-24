#!/bin/sh
# Start CUPS and (re)create the one DYMO queue from the environment. Never prints or talks to the printer itself.
set -eu
: "${CUPS_QUEUE:=DYMO_5XL}"
: "${PRINTER_PORT:=9100}"
PPD="$(find /usr/share/cups /usr/share/ppd -name lw5xl.ppd 2>/dev/null | head -n 1)"

cupsd -f &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; exit 0' TERM INT

i=0
until lpstat -r >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 50 ] && { echo "CUPS did not start." >&2; exit 1; }
  sleep 0.2
done

if [ -n "${PRINTER_HOST:-}" ]; then
  uri="socket://${PRINTER_HOST}:${PRINTER_PORT}/?waiteof=false&contimeout=5"
  # lpadmin on an existing queue updates it in place and keeps its jobs.
  lpadmin -p "$CUPS_QUEUE" -E -v "$uri" -P "$PPD" -o printer-is-shared=false
  cupsenable "$CUPS_QUEUE"
  cupsaccept "$CUPS_QUEUE"
  echo "Queue $CUPS_QUEUE -> $uri ($PPD)"
else
  echo "PRINTER_HOST is not set; no queue was configured." >&2
fi

wait "$pid"
