import { describe, it, expect } from 'vitest';
import { parseManifest, ManifestParseError } from './parse.ts';

describe('parseManifest', () => {
  it('parses a single Deployment', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: default
spec:
  selector:
    matchLabels: { app: api }
  template:
    spec:
      containers:
        - name: api
          image: ./dist/worker.js
`;
    const result = parseManifest(yaml);
    expect(result.resources).toHaveLength(1);
    const r = result.resources[0]!;
    expect(r.kind).toBe('Deployment');
    expect(r.metadata.name).toBe('api');
    expect(result.warnings).toHaveLength(0);
  });

  it('parses multi-document YAML', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  selector:
    matchLabels: { app: api }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
data:
  LOG_LEVEL: info
`;
    const result = parseManifest(yaml);
    expect(result.resources).toHaveLength(2);
    expect(result.resources.map((r) => r.kind)).toEqual(['Deployment', 'ConfigMap']);
  });

  it('handles empty input', () => {
    expect(parseManifest('').resources).toHaveLength(0);
    expect(parseManifest('# only a comment\n').resources).toHaveLength(0);
  });

  it('skips empty documents between separators', () => {
    const yaml = `---
---
apiVersion: v1
kind: ConfigMap
metadata: { name: c }
data: { k: v }
---
---
`;
    const result = parseManifest(yaml);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.kind).toBe('ConfigMap');
  });

  it('defaults namespace to "default" when omitted', () => {
    const yaml = `
apiVersion: v1
kind: ConfigMap
metadata: { name: c }
data: { k: v }
`;
    const result = parseManifest(yaml);
    expect(result.resources[0]!.metadata.namespace).toBe('default');
  });

  it('preserves explicit namespace', () => {
    const yaml = `
apiVersion: v1
kind: ConfigMap
metadata: { name: c, namespace: prod }
data: { k: v }
`;
    const result = parseManifest(yaml);
    expect(result.resources[0]!.metadata.namespace).toBe('prod');
  });

  it('rejects unknown kind', () => {
    const yaml = `
apiVersion: example.com/v1
kind: WeirdResource
metadata: { name: w }
`;
    expect(() => parseManifest(yaml)).toThrow(ManifestParseError);
    expect(() => parseManifest(yaml)).toThrow(/unknown kind.*WeirdResource/i);
  });

  it('rejects bare Pod with explanatory message', () => {
    const yaml = `
apiVersion: v1
kind: Pod
metadata: { name: p }
spec:
  containers:
    - { name: c, image: foo }
`;
    expect(() => parseManifest(yaml)).toThrow(/Pod.*not supported/i);
    expect(() => parseManifest(yaml)).toThrow(/Deployment/);
  });

  it('rejects DaemonSet with explanatory message', () => {
    const yaml = `
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: d }
spec:
  selector: { matchLabels: { a: b } }
  template:
    spec:
      containers: [{ name: c, image: x }]
`;
    expect(() => parseManifest(yaml)).toThrow(/DaemonSet.*not supported/i);
  });

  it('warns and skips HorizontalPodAutoscaler (no-op)', () => {
    const yaml = `
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: hpa }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  minReplicas: 1
  maxReplicas: 10
`;
    const result = parseManifest(yaml);
    expect(result.resources).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toMatch(/auto-?scale/i);
    expect(result.warnings[0]!.ref?.kind).toBe('HorizontalPodAutoscaler');
  });

  it('parses R2Bucket CRD', () => {
    const yaml = `
apiVersion: cloudflare.k1c.io/v1alpha1
kind: R2Bucket
metadata: { name: media }
spec: { location: weur, storageClass: Standard }
`;
    const result = parseManifest(yaml);
    const r = result.resources[0]!;
    expect(r.kind).toBe('R2Bucket');
    expect(r.metadata.name).toBe('media');
    if (r.kind === 'R2Bucket') {
      expect(r.spec.location).toBe('weur');
    }
  });

  it('parses KVNamespace CRD with empty spec', () => {
    const yaml = `
apiVersion: cloudflare.k1c.io/v1alpha1
kind: KVNamespace
metadata: { name: cache }
spec: {}
`;
    const result = parseManifest(yaml);
    expect(result.resources[0]!.kind).toBe('KVNamespace');
  });

  it('parses Rollout with strategy.blueGreen', () => {
    const yaml = `
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
  strategy:
    blueGreen:
      autoPromotionEnabled: true
`;
    const result = parseManifest(yaml);
    expect(result.resources[0]!.kind).toBe('Rollout');
  });

  it('parses Rollout with strategy.canary.steps', () => {
    const yaml = `
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers:
        - { name: api, image: ./dist/worker.js }
  strategy:
    canary:
      steps:
        - { setWeight: 10 }
        - { pause: { duration: 5m } }
        - { setWeight: 50 }
        - { setWeight: 100 }
`;
    const result = parseManifest(yaml);
    const r = result.resources[0]!;
    expect(r.kind).toBe('Rollout');
    if (r.kind === 'Rollout' && 'canary' in r.spec.strategy) {
      expect(r.spec.strategy.canary.steps).toHaveLength(4);
    } else {
      expect.fail('expected canary strategy');
    }
  });

  it('parses Secret with stringData', () => {
    const yaml = `
apiVersion: v1
kind: Secret
metadata: { name: s }
type: Opaque
stringData:
  TOKEN: abc
`;
    const result = parseManifest(yaml);
    const r = result.resources[0]!;
    expect(r.kind).toBe('Secret');
    if (r.kind === 'Secret') {
      expect(r.stringData).toEqual({ TOKEN: 'abc' });
    }
  });

  it('reports validation errors with field path', () => {
    const yaml = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    spec:
      containers: []
`;
    expect(() => parseManifest(yaml)).toThrow(/containers/);
  });

  it('rejects manifest missing kind', () => {
    const yaml = `
apiVersion: v1
metadata: { name: x }
data: { k: v }
`;
    expect(() => parseManifest(yaml)).toThrow(/missing.*kind/i);
  });

  it('rejects malformed YAML with parse error context', () => {
    const yaml = `
apiVersion: v1
kind: ConfigMap
  bad-indent: oops
`;
    expect(() => parseManifest(yaml)).toThrow();
  });

  it('rejects mismatched apiVersion for known kind', () => {
    const yaml = `
apiVersion: v1
kind: Deployment
metadata: { name: x }
spec:
  selector: { matchLabels: { a: b } }
  template:
    spec:
      containers: [{ name: c, image: i }]
`;
    expect(() => parseManifest(yaml)).toThrow(/apiVersion/i);
  });
});
