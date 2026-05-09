{{/*
Helper templates. Files starting with `_` are not rendered as standalone
manifests by Helm and are explicitly skipped by k1c's directory loader, so
both tools agree on what counts as a manifest.
*/}}

{{- define "k1c-hello.workerRefName" -}}
{{ .Values.worker.name }}
{{- end -}}
