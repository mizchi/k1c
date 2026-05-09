{{- define "k1c-operator.namespace" -}}
{{- default .Release.Namespace .Values.namespace -}}
{{- end -}}

{{- define "k1c-operator.leaseNamespace" -}}
{{- default (include "k1c-operator.namespace" .) .Values.operator.leaseNamespace -}}
{{- end -}}

{{- define "k1c-operator.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{ .Values.image.repository }}:{{ $tag }}
{{- end -}}

{{- define "k1c-operator.labels" -}}
app: k1c-operator
app.kubernetes.io/name: k1c-operator
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ default .Chart.AppVersion .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "k1c-operator.selectorLabels" -}}
app: k1c-operator
app.kubernetes.io/name: k1c-operator
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
