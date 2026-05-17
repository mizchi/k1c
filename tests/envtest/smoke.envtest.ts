import { describe, expect, it } from 'vitest';
import * as k8s from '@kubernetes/client-node';

/**
 * Sanity check that the envtest harness wired by `tests/envtest/_setup.ts`
 * produces a working apiserver and that `@kubernetes/client-node` can
 * talk to it with the kubeconfig we wrote. Failures here are not k1c
 * bugs — they mean the envtest binary fetch or the cluster wrapper
 * regressed.
 */
describe('envtest smoke', () => {
  it('apiserver reports a 1.x version through the typed client', async () => {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const api = kc.makeApiClient(k8s.VersionApi);
    const v = await api.getCode();
    expect(v.gitVersion).toMatch(/^v1\./);
  });

  it('CRDs round-trip: create → list → delete', async () => {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const api = kc.makeApiClient(k8s.ApiextensionsV1Api);

    const crd: k8s.V1CustomResourceDefinition = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'envtestwidgets.k1c.test' },
      spec: {
        group: 'k1c.test',
        scope: 'Namespaced',
        names: {
          plural: 'envtestwidgets',
          singular: 'envtestwidget',
          kind: 'EnvtestWidget',
          listKind: 'EnvtestWidgetList',
        },
        versions: [
          {
            name: 'v1alpha1',
            served: true,
            storage: true,
            schema: {
              openAPIV3Schema: {
                type: 'object',
                properties: {
                  spec: {
                    type: 'object',
                    properties: { greeting: { type: 'string' } },
                  },
                },
              },
            },
          },
        ],
      },
    };

    await api.createCustomResourceDefinition({ body: crd });
    try {
      const list = await api.listCustomResourceDefinition();
      const names = list.items.map((c) => c.metadata?.name ?? '');
      expect(names).toContain('envtestwidgets.k1c.test');
    } finally {
      await api.deleteCustomResourceDefinition({ name: 'envtestwidgets.k1c.test' });
    }
  });
});
