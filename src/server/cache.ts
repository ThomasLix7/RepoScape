import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import yaml from 'js-yaml';
import { parse as parseJsonc } from 'jsonc-parser';

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
