FROM node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
# Camoufox is Firefox-based; only its system libraries are installed. The binary is mounted.
RUN node node_modules/playwright-core/cli.js install-deps firefox && rm -rf /var/lib/apt/lists/*
COPY src ./src
ENV NODE_ENV=production
# The isolated browser worker resolves its home through passwd; it does not inherit HOME.
RUN groupadd --gid 10001 fetchx \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /home/fetchx --shell /usr/sbin/nologin --no-log-init fetchx \
 && install -d -o root -g root -m 0755 /home/fetchx
USER 10001:10001
CMD ["node","src/server.mjs"]
