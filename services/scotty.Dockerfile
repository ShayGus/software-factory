# Build only the pinned public Scotty source; the installer supplies verified bd.
# Ticket edits use bd; showcase publishing and agent tooling are not installed.
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NEXT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends bash jq git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOME=/tmp
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY .sf/bd /usr/local/bin/bd
EXPOSE 3000
CMD ["node", "server.js"]
