import chokidar from 'chokidar';
import path from 'path';
import { GraphCompiler } from './compiler.js';
import { appendErrorLog } from './logger.js';
import { GraphDiff } from './types.js';

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private projectRoot: string;
  private watchRoot: string;
  private compiler: GraphCompiler;
  private onGraphUpdate: (diff: GraphDiff) => void;
  private onFocus?: (changedFiles: string[]) => void;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingChanges: Set<string> = new Set();
  private pendingDeletes: Set<string> = new Set();

  constructor(
    projectRoot: string,
    compiler: GraphCompiler,
    onGraphUpdate: (diff: GraphDiff) => void,
    watchRoot?: string,
    onFocus?: (changedFiles: string[]) => void
  ) {
    this.projectRoot = projectRoot;
    this.compiler = compiler;
    this.onGraphUpdate = onGraphUpdate;
    this.watchRoot = watchRoot || projectRoot;
    this.onFocus = onFocus;
  }

  start(): void {
    this.watcher = chokidar.watch(this.watchRoot, {
      ignored: [
        /(^|[\/\\])\../,
        /node_modules/,
        /\.reposcape/,
        /dist/,
        /build/,
        /\.next/,
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on('change', (filePath) => this.handleEvent('change', filePath));
    this.watcher.on('add', (filePath) => this.handleEvent('add', filePath));
    this.watcher.on('unlink', (filePath) => this.handleEvent('unlink', filePath));
    this.watcher.on('error', (error) => {
      appendErrorLog(this.projectRoot, `File watcher error: ${error.message}`);
    });
  }

  // §3.C: Record intent only — no direct handleFileDelete calls
  private handleEvent(event: string, filePath: string): void {
    const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');

    if (event === 'unlink') {
      this.pendingDeletes.add(relativePath);
    } else {
      this.pendingChanges.add(relativePath);
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => this.flushChanges(), 100);
  }

  // §3.A: Use compileAndDiff() — atomic snapshot-compile-diff in a single transaction
  private async flushChanges(): Promise<void> {
    const changes = new Set(this.pendingChanges);
    const deletes = new Set(this.pendingDeletes);
    this.pendingChanges.clear();
    this.pendingDeletes.clear();

    if (changes.size === 0 && deletes.size === 0) return;

    try {
      // §3.A: Atomic — compiler handles snapshot, compile, and diff in one transaction
      const { diff, graph } = await this.compiler.compileAndDiff();

      // §4: Include hubNodes in diff
      const hubNodes = Array.from(this.compiler.getHubNodes());

      this.onGraphUpdate({
        ...diff,
        hubNodes,
      });

      // Highlight the nodes for files that were just edited (not deletes —
      // their nodes are gone). source_file uses the same project-relative,
      // forward-slashed form as `changes`, so these match directly.
      if (this.onFocus && changes.size > 0) {
        this.onFocus(Array.from(changes));
      }
    } catch (err: any) {
      await appendErrorLog(this.projectRoot, `Error during incremental compile: ${err.message}`);
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.watcher) {
      this.watcher.close();
    }
  }
}
