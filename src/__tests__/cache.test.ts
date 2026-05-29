import { describe, it, expect } from 'vitest';
import { getCanonicalConfigHash, hashSourceFile } from '../server/cache.js';

describe('getCanonicalConfigHash', () => {
  it('should strip JSON comments and return canonical JSON', () => {
    const text = '{ "foo": "bar", // comment\n "baz": 42 }';
    const result = getCanonicalConfigHash(text, '.jsonc');
    expect(result).toBe(JSON.stringify({ foo: 'bar', baz: 42 }));
  });

  it('should parse regular JSON', () => {
    const text = '{"a": 1, "b": 2}';
    const result = getCanonicalConfigHash(text, '.json');
    expect(result).toBe('{"a":1,"b":2}');
  });

  it('should parse YAML', () => {
    const text = 'a: 1\nb: 2';
    const result = getCanonicalConfigHash(text, '.yaml');
    expect(result).toBe(JSON.stringify({ a: 1, b: 2 }));
  });

  it('should return raw text for unknown extensions', () => {
    const text = 'hello world';
    const result = getCanonicalConfigHash(text, '.txt');
    expect(result).toBe('hello world');
  });
});

describe('hashSourceFile', () => {
  it('should produce consistent hashes', () => {
    const hash1 = hashSourceFile('src/foo.ts');
    const hash2 = hashSourceFile('src/foo.ts');
    expect(hash1).toBe(hash2);
  });

  it('should normalize backslashes to forward slashes', () => {
    const hash1 = hashSourceFile('src\\foo.ts');
    const hash2 = hashSourceFile('src/foo.ts');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different paths', () => {
    const hash1 = hashSourceFile('src/foo.ts');
    const hash2 = hashSourceFile('src/bar.ts');
    expect(hash1).not.toBe(hash2);
  });
});
