FROM node@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir curl_cffi==0.13.0 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN node node_modules/playwright-core/cli.js install-deps chromium && rm -rf /var/lib/apt/lists/*
COPY src ./src
COPY knowledge ./knowledge
ENV GATEWAY_PYTHON=/opt/venv/bin/python3 NODE_ENV=production
USER 10001:10001
CMD ["node","src/main.mjs"]
