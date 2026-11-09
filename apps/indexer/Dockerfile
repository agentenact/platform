# Built from apps/indexer (servel ignores build.context). The library comes from libs/ as a packed tarball.
FROM oven/bun:1.4.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY libs ./libs
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Drops the superuser variables the servel infra link injects before the process starts (see entrypoint.sh).
COPY --chmod=755 entrypoint.sh ./entrypoint.sh
USER bun
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "src/main.ts"]
