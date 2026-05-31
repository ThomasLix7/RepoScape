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
    const rulesFile = path.join(this.projectRoot, '.reposcape', 'architecture_rules.json');
    this.watcher = chokidar.watch([this.watchRoot, rulesFile], {
      // Ignore dotfiles / build dirs / .reposcape, but allow the radar rules file
      // back in so editing it re-triggers a compile.
      ignored: (filePath: string) => {
        if (filePath === rulesFile) return false;
        return (
          /(^|[\/\\])\../.test(filePath) ||
          /node_modules/.test(filePath) ||
          /\.reposcape/.test(filePath) ||
          /dist/.test(filePath) ||
          /build/.test(filePath) ||
          /\.next/.test(filePath)
        );
      },
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

  private handleEvent(event: string, filePath: string): void {
    const relativePath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');

    if (event === 'unlink') {
      this.pendingDeletes.add(relativePath);
    } else {
      this.pendingChanges.add(relativePath);
      // Immediate highlight before debounced recompile.
      this.onFocus?.([relativePath]);
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => this.flushChanges(), 100);
  }

  private async flushChanges(): Promise<void> {
    const changes = new Set(this.pendingChanges);
    const deletes = new Set(this.pendingDeletes);
    this.pendingChanges.clear();
    this.pendingDeletes.clear();

    if (changes.size === 0 && deletes.size === 0) return;

    try {
      const { diff, graph } = await this.compiler.compileAndDiff();

      const hubNodes = Array.from(this.compiler.getHubNodes());

      this.onGraphUpdate({
        ...diff,
        hubNodes,
      });

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
