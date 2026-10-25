#!/bin/sh
# Start CUPS and (re)create the DYMO queue from the environment. Never prints or talks to the printer itself.
# PRINTER_MODEL picks the driver: lw5xl, lw550t, lw550 (LW5xx driver) or lw450, lw4xl (CUPS DYMO driver).
# PRINTER_URI overrides the network address, for example a USB printer passed into the container.
set -eu
: "${CUPS_QUEUE:=DYMO_5XL}"
: "${PRINTER_PORT:=9100}"
: "${PRINTER_MODEL:=lw5xl}"
case "$PRINTER_MODEL" in
  lw5xl|lw550t|lw550) DRIVER="-P $(find /usr/share/cups /usr/share/ppd -name "$PRINTER_MODEL.ppd" 2>/dev/null | head -n 1)" ;;
  lw450|lw4xl) DRIVER="-m dymo:0/cups/model/$PRINTER_MODEL.ppd" ;;
  *) echo "Unsupported PRINTER_MODEL: $PRINTER_MODEL" >&2; exit 1 ;;
esac

cupsd -f &
pid=$!
trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; exit 0' TERM INT

i=0
until lpstat -r >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 50 ] && { echo "CUPS did not start." >&2; exit 1; }
  sleep 0.2
done

uri="${PRINTER_URI:-}"
[ -z "$uri" ] && [ -n "${PRINTER_HOST:-}" ] && uri="socket://${PRINTER_HOST}:${PRINTER_PORT}/?waiteof=false&contimeout=5"
if [ -n "$uri" ]; then
  # lpadmin on an existing queue updates it in place and keeps its jobs. The queue must be shared:
  # CUPS refuses Print-Job from the api container on an unshared queue. Browsing is off, so it is not advertised.
  # cupsd may answer lpstat before it accepts administrative requests, so lpadmin gets a few attempts.
  i=0
  # shellcheck disable=SC2086
  until lpadmin -p "$CUPS_QUEUE" -E -v "$uri" $DRIVER -o printer-is-shared=true; do
    i=$((i + 1)); [ "$i" -gt 20 ] && { echo "lpadmin failed." >&2; exit 1; }
    sleep 0.5
  done
  cupsenable "$CUPS_QUEUE"
  cupsaccept "$CUPS_QUEUE"
  echo "Queue $CUPS_QUEUE -> $uri ($PRINTER_MODEL)"
else
  echo "Neither PRINTER_HOST nor PRINTER_URI is set; no queue was configured." >&2
fi

wait "$pid"
