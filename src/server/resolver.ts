import path from 'path';
import fs from 'fs/promises';
import { createRequire } from 'node:module';
import { ResolvedExport } from './types.js';

export function unwrapReexports(
  importedSymbol: string,
  targetFile: string,
  globalExports: Map<
    string,
    Map<string, string | { sourceFile: string; originalSymbol: string } | string[]>
  >
): ResolvedExport {
  let currentFile = targetFile;
  let currentSymbol = importedSymbol;
  const visited = new Set<string>();

  while (true) {
    const key = `${currentFile}::${currentSymbol}`;
    if (visited.has(key)) break;
    visited.add(key);

    const fileExports = globalExports.get(currentFile);
    if (!fileExports) break;

    const mapping = fileExports.get(currentSymbol);
    if (mapping) {
      if (typeof mapping === 'string') {
        currentFile = mapping;
      } else if (!Array.isArray(mapping)) {
        currentFile = mapping.sourceFile;
        currentSymbol = mapping.originalSymbol;
      }
      continue;
    }

    const starSource = fileExports.get('*');
    if (starSource) {
      if (typeof starSource === 'string') {
        currentFile = starSource;
        continue;
      } else if (Array.isArray(starSource)) {
        let found = false;
        for (const source of starSource) {
          const subExports = globalExports.get(source);
          if (subExports && (subExports.has(currentSymbol) || subExports.has('*'))) {
            currentFile = source;
            found = true;
            break;
          }
        }
        if (found) continue;
      }
    }
    break;
  }
  return { filePath: currentFile, symbol: currentSymbol };
}

export function identifyHubNodes(nodes: { id: string }[], edges: { source: string; target: string }[]): Set<string> {
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }

  const values = Array.from(degree.values());
  if (values.length === 0) return new Set();

  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);

  const cutoff = mean + 5 * stdDev;
  const hubNodes = new Set<string>();
  for (const [nid, deg] of degree.entries()) {
    if (deg > cutoff && deg > 50) {
      hubNodes.add(nid);
    }
  }
  return hubNodes;
}

// §2.C: ModuleResolver — converts (callerFile, moduleSpecifier) → projectRelativePath | null
export class ModuleResolver {
  private projectRoot: string;
  private tsconfigDir: string = '';
  private baseUrl: string = '.';
  private paths: Record<string, string[]> = {};
  private supportedExtensions: string[] = ['.ts', '.tsx', '.js', '.jsx'];
  private initialized = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Find and parse tsconfig.json
    const tsconfigPath = await this.findTsconfig();
    if (tsconfigPath) {
      this.tsconfigDir = path.dirname(tsconfigPath);
      try {
        const raw = await fs.readFile(tsconfigPath, 'utf-8');
        const { parse: parseJsonc } = await import('jsonc-parser');
        const config = parseJsonc(raw) as any;
        if (config?.compilerOptions?.baseUrl) {
          this.baseUrl = config.compilerOptions.baseUrl;
        }
        if (config?.compilerOptions?.paths) {
          this.paths = config.compilerOptions.paths;
        }
      } catch {
        // tsconfig not parseable — no aliases
      }
    }
  }

  setSupportedExtensions(exts: string[]): void {
    this.supportedExtensions = exts;
  }

  private async findTsconfig(): Promise<string | null> {
    let dir = this.projectRoot;
    while (true) {
      const candidate = path.join(dir, 'tsconfig.json');
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try jsconfig.json too
        const jsCandidate = path.join(dir, 'jsconfig.json');
        try {
          await fs.access(jsCandidate);
          return jsCandidate;
        } catch {
          // continue up
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  // §2.C: Main resolution pipeline
  async resolve(callerFile: string, moduleSpecifier: string): Promise<string | null> {
    if (!this.initialized) await this.init();

    // Step 1/2: Generate candidates
    const candidates: string[] = [];

    if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
      // Step 2: Relative resolution
      const callerDir = path.dirname(callerFile);
      const absCandidate = path.resolve(this.projectRoot, callerDir, moduleSpecifier);
      candidates.push(absCandidate);
    } else {
      // Step 1: Path-alias rewrite (non-relative specifiers)
      const aliasCandidates = this.resolveAliases(moduleSpecifier);
      if (aliasCandidates.length > 0) {
        candidates.push(...aliasCandidates);
      }
      // If no alias match, this is a bare package — return null
      if (aliasCandidates.length === 0) {
        return null;
      }
    }

    // Steps 3-5: Try each candidate
    for (const absCandidate of candidates) {
      const result = await this.tryCandidate(absCandidate);
      if (result) return result;
    }

    return null;
  }

  private resolveAliases(specifier: string): string[] {
    const candidates: string[] = [];
    for (const [pattern, targets] of Object.entries(this.paths)) {
      const prefix = pattern.replace(/\*$/, '');
      const suffix = specifier.slice(prefix.length);
      if (specifier.startsWith(prefix)) {
        const baseDir = path.resolve(this.tsconfigDir, this.baseUrl);
        for (const target of targets) {
          const resolved = target.replace('*', suffix);
          candidates.push(path.resolve(baseDir, resolved));
        }
      }
    }
    return candidates;
  }

  private async tryCandidate(absPath: string): Promise<string | null> {
    // Step 3: ESM .js/.jsx source rewrite
    let candidate = absPath;
    if (candidate.endsWith('.js')) {
      const tsCandidate = candidate.slice(0, -3) + '.ts';
      const tsxCandidate = candidate.slice(0, -3) + '.tsx';
      if (await this.fileExistsCaseSensitive(tsCandidate)) {
        candidate = tsCandidate;
      } else if (await this.fileExistsCaseSensitive(tsxCandidate)) {
        candidate = tsxCandidate;
      }
    } else if (candidate.endsWith('.jsx')) {
      const tsxCandidate = candidate.slice(0, -4) + '.tsx';
      const tsCandidate = candidate.slice(0, -4) + '.ts';
      if (await this.fileExistsCaseSensitive(tsxCandidate)) {
        candidate = tsxCandidate;
      } else if (await this.fileExistsCaseSensitive(tsCandidate)) {
        candidate = tsCandidate;
      }
    }

    // Step 4: Extension / index fallback
    // If the candidate has a registered extension and exists, accept it
    const ext = path.extname(candidate);
    if (this.supportedExtensions.includes(ext)) {
      if (await this.fileExistsCaseSensitive(candidate)) {
        return this.sandboxAndRelativize(candidate);
      }
    }

    // Try adding extensions
    for (const ext of this.supportedExtensions) {
      const withExt = candidate + ext;
      if (await this.fileExistsCaseSensitive(withExt)) {
        return this.sandboxAndRelativize(withExt);
      }
    }

    // Try index files
    for (const ext of this.supportedExtensions) {
      const indexPath = path.join(candidate, `index${ext}`);
      if (await this.fileExistsCaseSensitive(indexPath)) {
        return this.sandboxAndRelativize(indexPath);
      }
    }

    return null;
  }

  // Step 5: Sandbox check + relativize
  private sandboxAndRelativize(absPath: string): string | null {
    const rel = path.relative(this.projectRoot, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return null; // escapes root
    }
    return rel.replace(/\\/g, '/');
  }

  private async fileExistsCaseSensitive(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }
}
