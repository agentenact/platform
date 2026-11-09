# Built from apps/api (servel ignores build.context). The library comes from libs/ (servel excludes any vendor/ dir) as a packed tarball.
FROM oven/bun:1.3.11 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY libs ./libs
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.11
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Drops the admin credentials the servel infra link injects before the process starts (see entrypoint.sh).
COPY --chmod=755 entrypoint.sh ./entrypoint.sh
# Fail the build, not the first compute call, if the isolate pool (QuickJS WASM, linkedom, Readability) cannot run a job.
RUN bun run src/tools/isolate-smoke.ts
# servel passes the deploy time (RFC3339) as a build arg; the api orders start-first handovers by it (src/db/index.ts).
# Declared after the RUN steps so a new value never invalidates their cache.
ARG SERVEL_DEPLOY_TIME
ENV SERVEL_DEPLOY_TIME=$SERVEL_DEPLOY_TIME
USER bun
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=240s CMD bun -e "const r = await fetch('http://127.0.0.1:8080/health'); process.exit(r.ok ? 0 : 1)"
ENTRYPOINT ["/app/entrypoint.sh", "api"]
CMD ["bun", "run", "src/main.ts"]
