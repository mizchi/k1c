import type { CloudflareResourceProvider } from './types.ts';

export class ProviderRegistry {
  readonly #providers = new Map<string, CloudflareResourceProvider<unknown>>();

  register<P>(provider: CloudflareResourceProvider<P>): void {
    if (this.#providers.has(provider.resourceType)) {
      throw new Error(`provider already registered: ${provider.resourceType}`);
    }
    this.#providers.set(
      provider.resourceType,
      provider as CloudflareResourceProvider<unknown>,
    );
  }

  get(resourceType: string): CloudflareResourceProvider<unknown> {
    const p = this.#providers.get(resourceType);
    if (!p) throw new Error(`no provider for resource type: ${resourceType}`);
    return p;
  }

  has(resourceType: string): boolean {
    return this.#providers.has(resourceType);
  }

  *types(): IterableIterator<string> {
    yield* this.#providers.keys();
  }
}
