# Container image for the k1c operator. Built and published from the main
# repo via a separate workflow (out of scope for the package itself).
#
# Build:  docker build -t ghcr.io/mizchi/k1c-operator:latest -f examples/k1c-operator/Dockerfile .
# Run:    docker run --rm -it -e K1C_ACCOUNT_ID=... -e CLOUDFLARE_API_TOKEN=... \
#           -v ~/.kube/config:/root/.kube/config:ro \
#           ghcr.io/mizchi/k1c-operator:latest operator run --interval 30

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
