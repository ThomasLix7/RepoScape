import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import yaml from 'js-yaml';
import { parse as parseJsonc } from 'jsonc-parser';
import { Tour } from './types.js';

export async function writeCacheAtomic(filePath: string, content: string): Promise<void> {
  const lockFile = `${filePath}.lock`;

  try {
    const stat = await fs.stat(lockFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 10000) {
      await fs.unlink(lockFile).catch(() => {});
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Retry up to 30 times (~3s)
  let retries = 30;
  while (retries > 0) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      await handle.close();
      break;
    } catch (err) {
      retries--;
      if (retries === 0) throw new Error(`Could not acquire cache file lock for: ${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 90));
    }
  }

  try {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.unlink(lockFile).catch(() => {});
  }
}

export function getCanonicalConfigHash(text: string, ext: string): string {
  if (ext === '.json' || ext === '.jsonc') {
    const obj = parseJsonc(text);
    return JSON.stringify(obj);
  }
  if (ext === '.yaml' || ext === '.yml') {
    const obj = yaml.load(text);
    return JSON.stringify(obj);
  }
  return text;
}

export function hashSourceFile(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const TOUR_CAP = 50;

const TOUR_ID_RE = /^[a-z0-9-]+$/;

export function toursDir(projectRoot: string): string {
  return path.join(projectRoot, '.reposcape', 'tours');
}

export function generateTourId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function isValidTourId(id: string): boolean {
  return TOUR_ID_RE.test(id);
}

export async function saveTour(projectRoot: string, tour: Tour): Promise<void> {
  if (!tour.id || !isValidTourId(tour.id)) throw new Error('Invalid tour id');
  const dir = toursDir(projectRoot);
  await ensureDir(dir);
  await writeCacheAtomic(path.join(dir, `${tour.id}.json`), JSON.stringify(tour, null, 2));


  const tours = await listTours(projectRoot);
  for (const stale of tours.slice(TOUR_CAP)) {
    if (stale.id) await deleteTour(projectRoot, stale.id);
  }
}

export async function listTours(projectRoot: string): Promise<Tour[]> {
  const dir = toursDir(projectRoot);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const tours = await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        return JSON.parse(content) as Tour;
      } catch {
        return null;
      }
    })
  );
  return tours
    .filter((t): t is Tour => t !== null)
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export async function deleteTour(projectRoot: string, id: string): Promise<void> {
  if (!isValidTourId(id)) throw new Error('Invalid tour id');
  await fs.unlink(path.join(toursDir(projectRoot), `${id}.json`)).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}
