{{/*
Common labels
*/}}
{{- define "ecommerce.labels" -}}
app.kubernetes.io/part-of: devops-ecommerce
environment: {{ .Values.environment }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "ecommerce.selectorLabels" -}}
app: {{ .name }}
{{- end }}

{{/*
Create chart name
*/}}
{{- define "ecommerce.fullname" -}}
{{ .Release.Name }}-{{ .Chart.Name }}
{{- end }}
