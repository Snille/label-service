FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS test
WORKDIR /app
COPY package.json VERSION ./
COPY src ./src
COPY test ./test
RUN node --test --test-timeout=20000

FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3230 LABEL_DB=/data/label-service.sqlite
WORKDIR /app
COPY --from=test --chown=node:node /app/src ./src
COPY --from=test --chown=node:node /app/package.json /app/VERSION ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3230
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3230/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
