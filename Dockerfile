FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/tiktok-client/package.json packages/tiktok-client/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS source
COPY . .

# Portable Node for Windows, served to computers that connect phones (checked against nodejs.org's SHA-256 list).
FROM alpine:3.20 AS boxphone-node
ARG NODE_WIN_VERSION=22.14.0
RUN apk add --no-cache ca-certificates && mkdir -p /runtime \
  && ( wget -q -O /runtime/node-win-x64.zip "https://nodejs.org/dist/v${NODE_WIN_VERSION}/node-v${NODE_WIN_VERSION}-win-x64.zip" \
    && wget -q -O /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_WIN_VERSION}/SHASUMS256.txt" \
    && expected="$(grep " node-v${NODE_WIN_VERSION}-win-x64.zip\$" /tmp/SHASUMS256.txt | cut -d' ' -f1)" \
    && test -n "$expected" && echo "$expected  /runtime/node-win-x64.zip" | sha256sum -c - ) \
  || ( rm -f /runtime/node-win-x64.zip; echo "Node package unavailable at build time; the installer downloads it from nodejs.org instead" )

FROM source AS web
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
RUN npm run build:web
COPY --from=boxphone-node /runtime /app/runtime
ENV NODE_OPTIONS="--require /app/scripts/http-timeouts.cjs"
EXPOSE 3100
CMD ["npm", "run", "start:web"]

FROM source AS api
RUN apk add --no-cache ffmpeg
RUN npm run build:shared && npm run build:client && npm run build:api
EXPOSE 4000
CMD ["npm", "run", "start:api"]

FROM source AS worker
RUN npm run build:shared && npm run build:worker
CMD ["npm", "run", "start:worker"]
