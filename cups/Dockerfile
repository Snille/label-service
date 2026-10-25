# CUPS with the official DYMO LabelWriter 5xx driver, matching the old server's working setup
# (Ubuntu 24.04, CUPS 2.4, driver built from source, lw5xl.ppd), plus the CUPS DYMO driver for the LabelWriter 450 and 4XL.
ARG UBUNTU=ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

FROM ${UBUNTU} AS driver
ARG DYMO_COMMIT=9f2f15b3f1c2dddf4dcdfb64f380748120d249ba
ARG DYMO_SHA256=d078100c36c57b34e64eb4d9545d0f08423f15f42026ce33c9abe06e082519d9
RUN apt-get update && apt-get install -y --no-install-recommends autoconf automake build-essential ca-certificates curl libboost-dev libcups2-dev libcupsimage2-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSL -o drivers.tar.gz "https://github.com/dymosoftware/Drivers/archive/${DYMO_COMMIT}.tar.gz" \
  && echo "${DYMO_SHA256}  drivers.tar.gz" | sha256sum -c - \
  && tar xzf drivers.tar.gz && mv "Drivers-${DYMO_COMMIT}/LW5xx_Linux" src
WORKDIR /build/src
# The shipped Makefile.in files are stale (they build raster2dymolw, while the PPDs need raster2dymolw_v2),
# so regenerate them from Makefile.am. The LabelManager monitor relies on <ctime> arriving indirectly,
# which GCC 13 no longer does.
RUN find src -name LabelManagerLanguageMonitorV2.cpp -exec sed -i '1i #include <ctime>' {} + \
  && autoreconf -fi && ./configure --prefix=/usr && make -j"$(nproc)" && make install DESTDIR=/out \
  && find /out -name raster2dymolw_v2 | grep -q . && find /out -name lw5xl.ppd | grep -q .

FROM ${UBUNTU}
RUN apt-get update && apt-get install -y --no-install-recommends cups cups-filters ghostscript libcupsimage2t64 printer-driver-dymo \
  && rm -rf /var/lib/apt/lists/*
COPY --from=driver /out/ /
# Both drivers must be present: raster2dymolw_v2 (5xx) and raster2dymolw (450/4XL), with their PPDs.
RUN test -x /usr/lib/cups/filter/raster2dymolw_v2 && test -x /usr/lib/cups/filter/raster2dymolw \
  && /usr/lib/cups/driver/dymo cat dymo:0/cups/model/lw450.ppd | grep -q 'raster2dymolw"' && find /usr/share/cups/model -name lw5xl.ppd | grep -q .
# Listen on the stack network only (the port is never published), accept the service name as host,
# allow printing from that network and keep administration local to the container.
RUN sed -i -e 's/^Listen localhost:631/Port 631/' -e 's/^WebInterface Yes/WebInterface No/' -e 's/^Browsing .*/Browsing No/' /etc/cups/cupsd.conf \
  && sed -i '/^<Location \/>$/,/^<\/Location>$/ s/^  Order allow,deny$/  Order allow,deny\n  Allow all/' /etc/cups/cupsd.conf \
  && printf 'ServerAlias *\nDefaultEncryption Never\n' >> /etc/cups/cupsd.conf \
  && cupsd -t
COPY entrypoint.sh /usr/local/bin/cups-entrypoint
RUN chmod 755 /usr/local/bin/cups-entrypoint
EXPOSE 631
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD lpstat -r | grep -q 'is running'
ENTRYPOINT ["/usr/local/bin/cups-entrypoint"]
