FROM --platform=linux/arm64 node:18-alpine AS builder
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY src/ ./
RUN yarn install --frozen-lockfile
RUN yarn build

CMD ["node", "dist/index.js"]
