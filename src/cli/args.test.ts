import { describe, it, expect } from 'vitest';
import { parseArgs } from './args.ts';

describe('parseArgs', () => {
  it('returns help when no arguments', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
  });

  it('returns help on --help', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('parses "apply -f path"', () => {
    expect(parseArgs(['apply', '-f', 'manifest.yaml'])).toEqual({
      kind: 'apply',
      file: 'manifest.yaml',
      dryRun: false,
      watch: false,
      quiet: false,
      validateOnly: false,
    });
  });

  it('parses "apply --file path"', () => {
    expect(parseArgs(['apply', '--file', 'manifest.yaml'])).toEqual({
      kind: 'apply',
      file: 'manifest.yaml',
      dryRun: false,
      watch: false,
      quiet: false,
      validateOnly: false,
    });
  });

  it('parses --dry-run flag', () => {
    expect(parseArgs(['apply', '-f', 'm.yaml', '--dry-run'])).toEqual({
      kind: 'apply',
      file: 'm.yaml',
      dryRun: true,
      watch: false,
      quiet: false,
      validateOnly: false,
    });
  });

  it('parses wrangler-config arguments', () => {
    expect(parseArgs(['wrangler-config', '-f', 'manifest.yaml'])).toEqual({
      kind: 'wrangler-config',
      file: 'manifest.yaml',
    });
    expect(
      parseArgs(['wrangler-config', '--file', 'manifest.yaml', '--worker', 'prod/api']),
    ).toEqual({
      kind: 'wrangler-config',
      file: 'manifest.yaml',
      worker: 'prod/api',
    });
  });

  it('parses --watch flag', () => {
    expect(parseArgs(['apply', '-f', 'm.yaml', '--watch'])).toEqual({
      kind: 'apply',
      file: 'm.yaml',
      dryRun: false,
      watch: true,
      quiet: false,
      validateOnly: false,
    });
  });

  it('parses --quiet / -q flag', () => {
    expect(parseArgs(['apply', '-f', 'm.yaml', '--quiet'])).toMatchObject({
      kind: 'apply',
      quiet: true,
      validateOnly: false,
    });
    expect(parseArgs(['apply', '-f', 'm.yaml', '-q'])).toMatchObject({ quiet: true });
  });

  it('rejects --dry-run + --watch together', () => {
    const r = parseArgs(['apply', '-f', 'm.yaml', '--dry-run', '--watch']);
    expect(r.kind).toBe('error');
  });

  it('accepts flags in any order', () => {
    expect(parseArgs(['apply', '--dry-run', '-f', 'm.yaml'])).toMatchObject({
      kind: 'apply',
      file: 'm.yaml',
      dryRun: true,
    });
  });

  it('parses "diff -f path"', () => {
    expect(parseArgs(['diff', '-f', 'manifest.yaml'])).toEqual({
      kind: 'diff',
      file: 'manifest.yaml',
      output: 'text',
      verbose: false,
    });
  });

  it('parses --verbose / --color on diff', () => {
    expect(parseArgs(['diff', '-f', 'm.yaml', '-v', '--color', 'always'])).toMatchObject({
      kind: 'diff',
      verbose: true,
      color: 'always',
    });
  });

  it('returns error when apply has no file', () => {
    const r = parseArgs(['apply']);
    expect(r.kind).toBe('error');
  });

  it('returns error when -f has no value', () => {
    const r = parseArgs(['apply', '-f']);
    expect(r.kind).toBe('error');
  });

  it('returns error for unknown subcommand', () => {
    const r = parseArgs(['frobnicate']);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/frobnicate/);
  });

  it('returns error for unknown flag', () => {
    const r = parseArgs(['apply', '-f', 'm.yaml', '--unknown']);
    expect(r.kind).toBe('error');
  });

  describe('rollout', () => {
    it('parses status subcommand with target and --dispatch', () => {
      expect(
        parseArgs(['rollout', 'status', 'default/api', '--dispatch', 'production']),
      ).toEqual({
        kind: 'rollout',
        subCommand: 'status',
        target: 'default/api',
        dispatch: 'production',
      });
    });

    it('parses promote subcommand', () => {
      const r = parseArgs(['rollout', 'promote', 'default/api', '--dispatch', 'prod']);
      expect(r.kind).toBe('rollout');
    });

    it('parses abort subcommand', () => {
      const r = parseArgs(['rollout', 'abort', 'default/api', '--dispatch', 'prod']);
      expect(r.kind).toBe('rollout');
    });

    it('returns error for unknown rollout subcommand', () => {
      const r = parseArgs(['rollout', 'frobnicate', 'default/api', '--dispatch', 'p']);
      expect(r.kind).toBe('error');
    });

    it('returns error when target is missing', () => {
      const r = parseArgs(['rollout', 'status']);
      expect(r.kind).toBe('error');
    });

    it('returns error when --dispatch is missing', () => {
      const r = parseArgs(['rollout', 'status', 'default/api']);
      expect(r.kind).toBe('error');
    });
  });

  describe('get / describe / delete', () => {
    it('parses get with kind only', () => {
      expect(parseArgs(['get', 'Worker'])).toEqual({
        kind: 'get',
        resourceKind: 'Worker',
        output: 'text',
      });
    });

    it('parses get with kind + name + namespace', () => {
      expect(parseArgs(['get', 'Worker', 'api', '-n', 'prod'])).toEqual({
        kind: 'get',
        resourceKind: 'Worker',
        name: 'api',
        namespace: 'prod',
        output: 'text',
      });
    });

    it('parses describe with required name', () => {
      expect(parseArgs(['describe', 'R2Bucket', 'media'])).toEqual({
        kind: 'describe',
        resourceKind: 'R2Bucket',
        name: 'media',
        output: 'text',
      });
    });

    it('parses -o json on get', () => {
      expect(parseArgs(['get', 'Worker', '-o', 'json'])).toMatchObject({
        kind: 'get',
        resourceKind: 'Worker',
        output: 'json',
      });
    });

    it('rejects unknown --output value', () => {
      const r = parseArgs(['get', 'Worker', '-o', 'xml']);
      expect(r.kind).toBe('error');
    });

    it('parses version subcommand', () => {
      expect(parseArgs(['version'])).toEqual({ kind: 'version' });
      expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
      expect(parseArgs(['-V'])).toEqual({ kind: 'version' });
    });

    it('returns error when describe is missing name', () => {
      expect(parseArgs(['describe', 'R2Bucket']).kind).toBe('error');
    });

    it('parses delete with -f and --cascade', () => {
      expect(parseArgs(['delete', '-f', 'm.yaml', '--cascade'])).toEqual({
        kind: 'delete',
        file: 'm.yaml',
        cascade: true,
      });
    });

    it('parses delete without --cascade defaults to false', () => {
      expect(parseArgs(['delete', '-f', 'm.yaml'])).toEqual({
        kind: 'delete',
        file: 'm.yaml',
        cascade: false,
      });
    });

    it('returns error when delete has no -f', () => {
      expect(parseArgs(['delete']).kind).toBe('error');
    });
  });
});
