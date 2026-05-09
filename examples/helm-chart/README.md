# k1c-hello (Helm chart)

Minimal Helm chart that demonstrates the Helm → k1c pipeline:

```sh
helm template ./examples/helm-chart \
  | K1C_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
    k1c apply -f - --dry-run
```

Or pass values:

```sh
helm template ./examples/helm-chart \
    --set worker.name=api \
    --set bucket.enabled=false \
    --set config.greeting='howdy' \
  | k1c apply -f - --dry-run
```

The chart only uses Helm template features — `if`, `quote`, `include` — so
the rendered output is plain k8s-shaped YAML that k1c can parse without
caring it came from Helm. Files under `templates/` whose name starts with
`_` (Helm convention for partials) are also skipped by k1c's directory
loader, so `k1c apply -f ./templates` works after a `helm template` flag
substitution if you ever want to skip Helm itself.
