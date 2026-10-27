FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS test
# rsvg-convert turns the label SVG into the PDF sent to CUPS and the PNG previews; poppler draws PDF pages as pictures.
RUN apt-get update && apt-get install -y --no-install-recommends librsvg2-bin poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json VERSION ./
RUN npm ci --omit=dev --ignore-scripts
COPY fonts ./fonts
COPY src ./src
COPY web ./web
COPY test ./test
RUN node --test --test-timeout=20000

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3230 LABEL_DB=/data/label-service.sqlite
RUN apt-get update && apt-get install -y --no-install-recommends librsvg2-bin poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=test --chown=node:node /app/node_modules ./node_modules
COPY --from=test --chown=node:node /app/fonts ./fonts
COPY --from=test --chown=node:node /app/src ./src
COPY --from=test --chown=node:node /app/web ./web
COPY --from=test --chown=node:node /app/package.json /app/VERSION ./
# /queues: the shared folder where the api writes the queue list for the cups container (LABEL_QUEUES_FILE).
RUN mkdir /data /queues && chown node:node /data /queues
USER node
VOLUME /data
EXPOSE 3230
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3230/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
