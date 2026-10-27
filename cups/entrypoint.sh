#!/bin/sh
# Start CUPS, (re)create the first DYMO queue from the environment, and keep the queues of printers added on the admin
# page in step with the file the api writes. Never prints or talks to the printer itself.
# PRINTER_MODEL picks the driver: lw5xl, lw550t, lw550 (LW5xx driver) or lw450, lw4xl (CUPS DYMO driver).
# PRINTER_URI overrides the network address, for example a USB printer passed into the container.
set -eu
: "${CUPS_QUEUE:=DYMO_5XL}"
: "${PRINTER_PORT:=9100}"
: "${PRINTER_MODEL:=lw5xl}"
: "${LABEL_QUEUES_FILE:=/queues/queues.txt}"

driver() {
  case "$1" in
    lw5xl|lw550t|lw550) echo "-P $(find /usr/share/cups /usr/share/ppd -name "$1.ppd" 2>/dev/null | head -n 1)" ;;
    lw450|lw4xl) echo "-m dymo:0/cups/model/$1.ppd" ;;
    *) return 1 ;;
  esac
}

# lpadmin on an existing queue updates it in place and keeps its jobs. The queue must be shared:
# CUPS refuses Print-Job from the api container on an unshared queue. Browsing is off, so it is not advertised.
# cupsd may answer lpstat before it accepts administrative requests, so lpadmin gets a few attempts.
make_queue() {
  queue=$1 model=$2 uri=$3
  options=$(driver "$model") || { echo "Unsupported printer model for $queue: $model" >&2; return 1; }
  i=0
  # shellcheck disable=SC2086
  until lpadmin -p "$queue" -E -v "$uri" $options -o printer-is-shared=true; do
    i=$((i + 1)); [ "$i" -gt 20 ] && { echo "lpadmin failed for $queue." >&2; return 1; }
    sleep 0.5
  done
  cupsenable "$queue"
  cupsaccept "$queue"
  echo "Queue $queue -> $uri ($model)"
}

# The api writes one line per added printer: "queue model device", with device socket://host[:port] or usb://...
# Lines are checked again here; a queue no longer listed is removed, except the queue from the environment.
apply_queues() {
  wanted=" $CUPS_QUEUE "
  while read -r queue model device extra; do
    case "$queue" in ''|'#'*) continue ;; esac
    if [ -n "$extra" ] || ! printf '%s' "$queue" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' || [ "$queue" = "$CUPS_QUEUE" ]; then
      echo "Skipping queue line for $queue." >&2; continue
    fi
    case "$device" in
      socket://*) printf '%s' "$device" | grep -Eq '^socket://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$' || { echo "Skipping $queue: bad address." >&2; continue; }
        uri="$device/?waiteof=false&contimeout=5" ;;
      usb://*) printf '%s' "$device" | grep -Eq '^usb://[A-Za-z0-9%/?=&._-]+$' || { echo "Skipping $queue: bad address." >&2; continue; }
        uri="$device" ;;
      *) echo "Skipping $queue: bad address." >&2; continue ;;
    esac
    current=$(lpstat -v "$queue" 2>/dev/null | sed -n 's/^device for [^:]*: //p')
    [ "$current" = "$uri" ] && [ "$(cat "/var/run/label-queue-$queue" 2>/dev/null)" = "$model" ] || { make_queue "$queue" "$model" "$uri" && echo "$model" > "/var/run/label-queue-$queue"; } || true
    wanted="$wanted$queue "
  done < "$LABEL_QUEUES_FILE"
  for queue in $(lpstat -e 2>/dev/null); do
    case "$wanted" in *" $queue "*) ;; *) lpadmin -x "$queue" && rm -f "/var/run/label-queue-$queue" && echo "Removed queue $queue" ;; esac
  done
}

# Looks at the file every few seconds and applies it when it changes. This reads a local file only; it never asks the
# printers anything.
watch_queues() {
  last=''
  while :; do
    if [ -f "$LABEL_QUEUES_FILE" ]; then
      sum=$(cksum < "$LABEL_QUEUES_FILE")
      [ "$sum" != "$last" ] && { apply_queues || echo "Applying $LABEL_QUEUES_FILE failed." >&2; last=$sum; }
    fi
    sleep 5
  done
}

driver "$PRINTER_MODEL" >/dev/null || { echo "Unsupported PRINTER_MODEL: $PRINTER_MODEL" >&2; exit 1; }

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
  make_queue "$CUPS_QUEUE" "$PRINTER_MODEL" "$uri" || exit 1
else
  echo "Neither PRINTER_HOST nor PRINTER_URI is set; no queue was configured from the environment." >&2
fi

watch_queues &

wait "$pid"
