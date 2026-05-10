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

# Validate every .pkl example by lowering it through k1c (zod).
# Skips files starting with `_` (PKL convention for import-only modules).
validate-pkl:
    #!/usr/bin/env bash
    set -e
    fail=0
    while IFS= read -r f; do
        case "$(basename "$f")" in _*) continue ;; esac
        echo "→ $f"
        if ! pnpm --silent k1c apply -f "$f" --validate-only; then
            echo "  ✗ failed"
            fail=1
        fi
    done < <(find examples -name '*.pkl' -type f)
    exit $fail

clean:
    rm -rf dist node_modules
