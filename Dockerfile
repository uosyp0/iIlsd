FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.pack.json boot.mjs ./
RUN node boot.mjs unpack
WORKDIR /app/.runtime
RUN npm ci
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MINI_APP_NAME
ARG SEO_ENABLED=false
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_MINI_APP_NAME=$NEXT_PUBLIC_MINI_APP_NAME SEO_ENABLED=$SEO_ENABLED NEXT_TELEMETRY_DISABLED=1
RUN npm run build && chown -R node:node /app
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "boot.mjs", "start"]
