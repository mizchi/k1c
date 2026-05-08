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

build:
    pnpm build

k1c *args:
    pnpm k1c {{args}}

clean:
    rm -rf dist node_modules
