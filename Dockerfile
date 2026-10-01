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

FROM source AS web
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH
RUN npm run build:web
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
