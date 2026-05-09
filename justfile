default:
    @just --list

install:
    pnpm install

typecheck:
    pnpm typecheck

test:
    pnpm test

test-watch:
    pnpm test:watch

# Run e2e tests against a real Cloudflare account.
# Requires K1C_E2E=1, K1C_ACCOUNT_ID, CLOUDFLARE_API_TOKEN to be exported.
test-e2e:
    pnpm test:e2e

secretlint:
    pnpm secretlint

build:
    pnpm build

k1c *args:
    pnpm k1c {{args}}

clean:
    rm -rf dist node_modules
