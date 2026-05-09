# Container image for the k1c operator. Produces an OCI v1.1 image via
# Docker buildx (linux/amd64 + linux/arm64). Built + pushed to GHCR by
# .github/workflows/release-please.yml on every release-please tag.
#
# Local build (single arch):
#   docker build -t k1c-operator:dev .
#
# Multi-arch build / push:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t ghcr.io/mizchi/k1c-operator:latest --push .
#
# Run locally against a real cluster:
#   docker run --rm -it -e K1C_ACCOUNT_ID=... -e CLOUDFLARE_API_TOKEN=... \
#     -v ~/.kube/config:/root/.kube/config:ro \
#     ghcr.io/mizchi/k1c-operator:latest operator run --interval 30

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-alpine
WORKDIR /app
COPY --from=build /src/dist ./dist
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./package.json
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["operator", "run", "--interval", "30"]
