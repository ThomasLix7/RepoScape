import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { CognitiveChunk, Tour } from './types.js';

let sessionToken = '';

export async function unlinkStaleToken(projectRoot: string): Promise<void> {
  const tokenPath = path.join(projectRoot, '.reposcape', '.session-token');
  try {
    await fs.unlink(tokenPath);
  } catch {
  }
}

export async function generateSessionToken(projectRoot: string): Promise<string> {
  sessionToken = crypto.randomBytes(32).toString('hex');
  const dir = path.join(projectRoot, '.reposcape');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.session-token'), sessionToken, 'utf-8');
  return sessionToken;
}

export function getSessionToken(): string {
  return sessionToken;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing session token' });
    return;
  }
  const clientToken = authHeader.split(' ')[1];

  const clientBuffer = Buffer.from(clientToken, 'utf-8');
  const tokenBuffer = Buffer.from(sessionToken, 'utf-8');

  if (
    clientBuffer.length !== tokenBuffer.length ||
    !crypto.timingSafeEqual(clientBuffer, tokenBuffer)
  ) {
    res.status(401).json({ error: 'Unauthorized: Invalid session token' });
    return;
  }
  next();
}

export async function sandboxPath(targetPath: string, projectRoot: string): Promise<string> {
  const resolvedRoot = await fs.realpath(projectRoot);
  let resolved: string;
  try {
    resolved = await fs.realpath(targetPath);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      resolved = path.resolve(targetPath);
    } else {
      throw err;
    }
  }
  const relative = path.relative(resolvedRoot, resolved);

  const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
  if (isOutside) {
    const inputHash = crypto.createHash('sha256').update(targetPath).digest('hex').slice(0, 12);
    throw new Error(
      `Security Violation: Path is outside the sandbox root jail [${inputHash}] (resolves to: ${resolved})`
    );
  }
  return resolved;
}

const validFileTypes = new Set(['code', 'document', 'concept']);
const validEdgeTypes = new Set(['PHYSICAL', 'COGNITIVE', 'SUSPICIOUS']);

function isValidEdgeMetadata(metadata: any): boolean {
  if (metadata === undefined || metadata === null) return true;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const keys = Object.keys(metadata);
  const allowed = new Set(['rationale', 'source_doc']);
  for (const key of keys) {
    if (!allowed.has(key)) return false;
    if (typeof metadata[key] !== 'string') return false;
  }
  return true;
}

export function validateTour(body: any): body is Tour {
  if (!body || typeof body !== 'object') return false;
  if (!Array.isArray(body.beats) || body.beats.length === 0) return false;
  if (body.title !== undefined && typeof body.title !== 'string') return false;
  for (const beat of body.beats) {
    if (!beat || typeof beat !== 'object') return false;
    if (typeof beat.say !== 'string' || !beat.say.trim()) return false;
    if (!Array.isArray(beat.nodes) || beat.nodes.some((n: any) => typeof n !== 'string')) return false;
    if (beat.lang !== undefined && typeof beat.lang !== 'string') return false;
  }
  return true;
}

export function validateCognitiveChunk(chunk: any): chunk is CognitiveChunk {
  if (!chunk || typeof chunk !== 'object') return false;
  if (!Array.isArray(chunk.nodes) || !Array.isArray(chunk.edges)) return false;

  for (const n of chunk.nodes) {
    if (typeof n.id !== 'string' || !n.id) return false;
    if (typeof n.label !== 'string') return false;
    if (typeof n.source_file !== 'string' || !n.source_file) return false;

    const isOutside =
      n.source_file.split(/[/\\]/).includes('..') || path.isAbsolute(n.source_file);
    if (isOutside) return false;

    if (!validFileTypes.has(n.file_type)) return false;
  }
  for (const e of chunk.edges) {
    if (typeof e.source !== 'string' || typeof e.target !== 'string') return false;
    if (typeof e.relation !== 'string') return false;
    if (!validEdgeTypes.has(e.type)) return false;
    if (typeof e.score !== 'number' || e.score < 0 || e.score > 1.0) return false;
    if (!isValidEdgeMetadata(e.metadata)) return false;
  }
  return true;
}
