FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
	libnss3 \
	libdbus-1-3 \
	libatk1.0-0 \
	libgbm-dev \
	libasound2 \
	libxrandr2 \
	libxkbcommon-dev \
	libxfixes3 \
	libxcomposite1 \
	libxdamage1 \
	libatk-bridge2.0-0 \
	libpango-1.0-0 \
	libcairo2 \
	libcups2 \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm

COPY package.json ./package.json
COPY pnpm-lock.yaml ./pnpm-lock.yaml

RUN pnpm install --frozen-lockfile
RUN pnpm exec remotion browser ensure

COPY src ./src
COPY public ./public
COPY tsconfig.json ./tsconfig.json
COPY remotion.config.ts ./remotion.config.ts

RUN pnpm exec remotion bundle

CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]

EXPOSE 8080
