# Kustomize example

Demonstrates the kustomize → k1c pipeline:

```sh
# Render base
kustomize build ./examples/kustomize/base \
  | k1c apply -f - --dry-run

# Render an overlay (adds extra-bucket, sets namespace=prod, patches the
# Deployment compatibility date)
kustomize build ./examples/kustomize/overlays/prod \
  | k1c apply -f - --dry-run
```

You can also point k1c straight at the base directory if you do not need
overlay/transform support:

```sh
k1c apply -f ./examples/kustomize/base --dry-run
```

k1c reads every `.yaml` / `.yml` under the directory (skipping files
starting with `_` or `.`) and concatenates them with `---` separators
before parsing.

## Supported kustomize subset

Anything kustomize emits as plain k8s YAML works. The features below are
exercised in the prod overlay:

  - `namespace:` field    → propagates as `metadata.namespace` on every
                            resource, picked up by k1c's lower step
  - `resources:` list     → multi-file aggregation (also supported by k1c
                            directly via directory mode)
  - `patches: { target, patch }` JSON-Patch transforms

`configMapGenerator` / `secretGenerator` work because the rendered output
is a plain `ConfigMap` / `Secret` k1c already understands. `images:`
substitution works because k1c reads `containers[].image` verbatim.
