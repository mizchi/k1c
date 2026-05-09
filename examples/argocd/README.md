# Argo CD GitOps install

Two Argo CD Applications that wire the k1c-operator + your k1c
manifests into a typical pull-based GitOps flow.

## Install order

```
1.  CRDs           ← run once, out of band
    k1c export-crds | kubectl apply -f -

2.  API token      ← out of band (don't commit)
    kubectl create ns k1c-system
    kubectl -n k1c-system create secret generic cloudflare-api-token \
      --from-literal=K1C_ACCOUNT_ID=<your-account-id> \
      --from-literal=CLOUDFLARE_API_TOKEN=<your-token>

3.  Operator app   ← references this repo's helm chart
    kubectl apply -n argocd -f k1c-operator-app.yaml

4.  Resources app  ← references YOUR infra repo
    # Edit k1c-resources-app.yaml first to point at your repo + path.
    kubectl apply -n argocd -f k1c-resources-app.yaml
```

## Why CRDs aren't part of the Argo CD app

Helm's CRD lifecycle is dangerous under GitOps. If Argo CD ever
prunes the helm release (e.g. namespace cleanup), it would delete
the CRDs as well — and that orphans every CR you've ever applied.

Best practice:

  * register CRDs once via `k1c export-crds | kubectl apply -f -`
  * exclude `apiextensions.k8s.io/CustomResourceDefinition` from
    Argo CD's prune scope (`spec.syncPolicy.syncOptions:
    - PruneLast=true` is not enough; an explicit Application that
    excludes CRDs is safer)

## ServerSideApply

Both Applications use `ServerSideApply=true` syncOption so the
apiserver's structural-schema validation kicks in before the operator
even sees the manifest. Combined with the OpenAPIV3 schemas the
operator now ships in its CRDs, this catches typos at git-merge time
instead of at reconcile time.

## Multi-cluster

For a fleet, point a single `Application` at a directory tree like
`clusters/<cluster>/k1c/` and use Argo CD `ApplicationSet` (with the
Cluster generator) to fan out. The operator's `--restrict-namespace`
flag is the right gate when a cluster hosts multiple tenants.
