import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  getCanonicalConfigHash,
  hashSourceFile,
  saveTour,
  listTours,
  deleteTour,
  generateTourId,
  isValidTourId,
} from '../server/cache.js';
import { Tour } from '../server/types.js';

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

describe('tour store', () => {
  let root: string;

  const makeTour = (overrides: Partial<Tour> = {}): Tour => ({
    id: generateTourId(),
    timestamp: Date.now(),
    beats: [{ say: 'hello', nodes: ['node_a'] }],
    ...overrides,
  });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'reposcape-tours-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves a tour and reads it back', async () => {
    const tour = makeTour({ title: 'Auth Flow' });
    await saveTour(root, tour);
    const tours = await listTours(root);
    expect(tours).toHaveLength(1);
    expect(tours[0].id).toBe(tour.id);
    expect(tours[0].title).toBe('Auth Flow');
  });

  it('returns [] when the tours dir does not exist yet', async () => {
    expect(await listTours(root)).toEqual([]);
  });

  it('keeps both tours when two are saved (no read-modify-write loss)', async () => {
    const a = makeTour({ id: 'aaa-1', timestamp: 1 });
    const b = makeTour({ id: 'bbb-2', timestamp: 2 });
    await Promise.all([saveTour(root, a), saveTour(root, b)]);
    const ids = (await listTours(root)).map((t) => t.id).sort();
    expect(ids).toEqual(['aaa-1', 'bbb-2']);
  });

  it('sorts newest first by timestamp', async () => {
    await saveTour(root, makeTour({ id: 'old-1', timestamp: 100 }));
    await saveTour(root, makeTour({ id: 'new-1', timestamp: 200 }));
    expect((await listTours(root)).map((t) => t.id)).toEqual(['new-1', 'old-1']);
  });

  it('deletes a tour by id', async () => {
    const tour = makeTour();
    await saveTour(root, tour);
    await deleteTour(root, tour.id!);
    expect(await listTours(root)).toHaveLength(0);
  });

  it('deleteTour is idempotent for a missing id', async () => {
    await expect(deleteTour(root, 'does-not-exist')).resolves.toBeUndefined();
  });

  it('skips corrupt files in listTours', async () => {
    const tour = makeTour({ id: 'good-1' });
    await saveTour(root, tour);
    await fs.writeFile(path.join(root, '.reposcape', 'tours', 'broken.json'), '{ not json', 'utf-8');
    const tours = await listTours(root);
    expect(tours.map((t) => t.id)).toEqual(['good-1']);
  });

  it('rejects an invalid tour id on save and delete', async () => {
    await expect(saveTour(root, makeTour({ id: '../escape' }))).rejects.toThrow('Invalid tour id');
    await expect(deleteTour(root, '../escape')).rejects.toThrow('Invalid tour id');
  });

  it('validates id charset', () => {
    expect(isValidTourId('abc-123')).toBe(true);
    expect(isValidTourId('../etc')).toBe(false);
    expect(isValidTourId('UPPER')).toBe(false);
  });
});
