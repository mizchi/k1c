import type { ProviderError, ProviderErrorCode } from './types.ts';

export interface CloudflareLikeAPIError {
  readonly status?: number;
  readonly message?: string;
  readonly name?: string;
}

export function toProviderError(raw: unknown): ProviderError {
  // Pass through if the value is already a ProviderError-shaped object.
  // Without this, providers that wrap once (`_ruleset-shared.getPhaseRules`)
  // and then re-wrap in their own catch silently lose the original
  // message — `String([object Object])` clobbers it.
  if (isProviderErrorShaped(raw)) return raw;
  if (isAPIError(raw)) {
    const status = raw.status ?? 0;
    const message = raw.message ?? 'Cloudflare API error';
    const code = statusToCode(status);
    return {
      code,
      recoverable: isRecoverableCode(code),
      message,
      cause: raw,
      ...(suggestForCode(code) ? { suggest: 'recreate' as const } : {}),
    };
  }
  if (raw instanceof Error) {
    return {
      code: 'NetworkFailure',
      recoverable: true,
      message: raw.message,
      cause: raw,
    };
  }
  return {
    code: 'ServiceInternalError',
    recoverable: true,
    message: String(raw),
    cause: raw,
  };
}

function isProviderErrorShaped(raw: unknown): raw is ProviderError {
  if (raw === null || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o['code'] === 'string' &&
    typeof o['recoverable'] === 'boolean' &&
    typeof o['message'] === 'string'
  );
}

function statusToCode(status: number): ProviderErrorCode {
  if (status === 404) return 'NotFound';
  if (status === 403 || status === 401) return 'AccessDenied';
  if (status === 409) return 'AlreadyExists';
  if (status === 429) return 'Throttling';
  if (status >= 500) return 'ServiceInternalError';
  if (status === 408) return 'ServiceTimeout';
  if (status >= 400) return 'InvalidRequest';
  return 'ServiceInternalError';
}

function isRecoverableCode(code: ProviderErrorCode): boolean {
  return (
    code === 'Throttling' ||
    code === 'NotStabilized' ||
    code === 'ServiceInternalError' ||
    code === 'ServiceTimeout' ||
    code === 'NetworkFailure'
  );
}

function suggestForCode(code: ProviderErrorCode): boolean {
  return code === 'NotFound' || code === 'NotUpdatable';
}

function isAPIError(raw: unknown): raw is CloudflareLikeAPIError {
  if (raw === null || typeof raw !== 'object') return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['status'] !== 'number') return false;
  return true;
}
