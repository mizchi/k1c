{
  description = "k1c dev shell — Cloudflare-side stays as-is, this just adds k8s tooling for operator end-to-end checks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          # Node / pnpm intentionally not pinned here — package.json's
          # packageManager + corepack already pin them per-repo. Adding the
          # tools that *do not* belong in package.json: a local k8s for
          # operator end-to-end checks.
          packages = with pkgs; [
            kind        # kubernetes-in-docker, brings up a cluster in a container
            kubectl     # talks to whichever cluster KUBECONFIG points at
            kubernetes-helm  # helm template, used by examples/helm-chart/
            kustomize   # kustomize build, used by examples/kustomize/
          ];

          shellHook = ''
            echo "k1c devShell:"
            echo "  kind     $(${pkgs.kind}/bin/kind version 2>&1 | head -1)"
            echo "  kubectl  $(${pkgs.kubectl}/bin/kubectl version --client --short 2>/dev/null | head -1 || echo "(installed)")"
            echo "  helm     $(${pkgs.kubernetes-helm}/bin/helm version --short 2>/dev/null || echo "(installed)")"
            echo "  kustomize $(${pkgs.kustomize}/bin/kustomize version 2>&1 | head -1)"
          '';
        };
      });
}
