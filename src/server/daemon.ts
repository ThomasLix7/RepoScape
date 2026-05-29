#!/usr/bin/env node

import express from 'express';
import { createServer } from 'http';
import net from 'net';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILE_THRESHOLD = 500;
const WORD_THRESHOLD = 2_000_000;

async function launchHUD(port: number, token: string): Promise<void> {
  const isLinuxNoDisplay =
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY;
  const suppressOpen =
    process.argv.includes('--no-open') || process.env.REPOSCAPE_NO_OPEN === '1';
  const isHeadless =
    suppressOpen ||
    process.env.CI === 'true' ||
    !!process.env.SSH_CLIENT ||
    isLinuxNoDisplay;
  const hudPort = port === 5174 ? 5173 : port;
  const hudUrl = `http://localhost:${hudPort}/hud.html?token=${encodeURIComponent(token)}`;

  if (isHeadless) {
    console.log(`\n🚀 HUD Server listening at ${hudUrl}`);
    console.log(`   (Headless environment detected - skipping browser auto-launch)\n`);
  } else {
    try {
      console.log(`\n🚀 HUD Server listening at ${hudUrl}`);
      console.log(`   Opening HUD visualizer in your browser...\n`);
      const open = (await import('open')).default;
      await open(hudUrl);
    } catch (err: any) {
      console.warn(
        `⚠️ Failed to auto-open browser: ${err.message}. Navigate manually to ${hudUrl}`
      );
    }
  }
}

function isPortInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (inUse: boolean) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function measureProjectSize(sourceFiles: string[]): Promise<{ fileCount: number; wordCount: number }> {
  const fileCount = sourceFiles.length;
  let wordCount = 0;

  const sampleSize = Math.min(100, fileCount);
  const step = Math.max(1, Math.floor(fileCount / sampleSize));
  let sampledWords = 0;
  let sampledCount = 0;

  for (let i = 0; i < fileCount; i += step) {
    try {
      const content = await fs.readFile(sourceFiles[i], 'utf-8');
      sampledWords += content.split(/\s+/).length;
      sampledCount++;
    } catch {
    }
  }

  if (sampledCount > 0) {
    wordCount = Math.round((sampledWords / sampledCount) * fileCount);
  }

  return { fileCount, wordCount };
}

async function getTopSubdirs(projectRoot: string, sourceFiles: string[]): Promise<{ name: string; count: number }[]> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles) {
    const rel = path.relative(projectRoot, file);
    const topDir = rel.split(path.sep)[0];
    counts.set(topDir, (counts.get(topDir) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

async function promptInput(message: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function projectSizeGuard(
  compiler: any,
  projectRoot: string
): Promise<{ proceed: boolean; scopeRoot?: string }> {
  const forceFlag = process.argv.includes('--force');
  const scopeIdx = process.argv.indexOf('--scope');
  const scopeDir = scopeIdx >= 0 ? process.argv[scopeIdx + 1] : undefined;

  if (forceFlag) return { proceed: true };
  if (scopeDir) {
    const resolvedScope = path.resolve(projectRoot, scopeDir);
    return { proceed: true, scopeRoot: resolvedScope };
  }

  const sourceFiles = await compiler.findSourceFiles();
  const { fileCount, wordCount } = await measureProjectSize(sourceFiles);

  if (fileCount <= FILE_THRESHOLD && wordCount <= WORD_THRESHOLD) {
    return { proceed: true };
  }

  console.warn('\n' + '='.repeat(60));
  console.warn('⚠️  REPOSCAPE PROJECT SIZE WARNING');
  console.warn('='.repeat(60));
  console.warn(`  Source files: ${fileCount} (threshold: ${FILE_THRESHOLD})`);
  console.warn(`  Estimated words: ${wordCount.toLocaleString()} (threshold: ${WORD_THRESHOLD.toLocaleString()})`);
  console.warn('');

  const topSubdirs = await getTopSubdirs(projectRoot, sourceFiles);
  console.warn('  Top subdirectories:');
  for (let i = 0; i < topSubdirs.length; i++) {
    console.warn(`    [${i + 1}] ${topSubdirs[i].name}/ — ${topSubdirs[i].count} files`);
  }
  console.warn(`    [${topSubdirs.length + 1}] Scan everything (--force)`);
  console.warn(`    [0] Cancel`);
  console.warn('');
  console.warn('  Or use --scope <dir> / --force from the command line.');
  console.warn('='.repeat(60));

  if (process.stdin.isTTY) {
    const answer = await promptInput('\n  Select a directory to scope [0]: ');
    const choice = parseInt(answer, 10);

    if (isNaN(choice) || choice === 0) {
      console.log('\n  Scanning cancelled.');
      return { proceed: false };
    }

    if (choice === topSubdirs.length + 1) {
      return { proceed: true };
    }

    if (choice >= 1 && choice <= topSubdirs.length) {
      const selected = topSubdirs[choice - 1];
      const scopeRoot = path.join(projectRoot, selected.name);
      console.log(`\n  Scoping to ${selected.name}/`);
      return { proceed: true, scopeRoot };
    }

    const typedDir = path.resolve(projectRoot, answer);
    try {
      const stat = await fs.stat(typedDir);
      if (stat.isDirectory()) {
        console.log(`\n  Scoping to ${answer}/`);
        return { proceed: true, scopeRoot: typedDir };
      }
    } catch {
    }

    console.log('\n  Invalid selection. Scanning cancelled.');
    return { proceed: false };
  }

  if (topSubdirs.length > 0) {
    const scopeRoot = path.join(projectRoot, topSubdirs[0].name);
    console.warn(`  Non-interactive mode: auto-scoping to ${topSubdirs[0].name}/. Use --force to override.`);
    return { proceed: true, scopeRoot };
  }

  console.warn('  Non-interactive mode: proceeding with full scan. Use --scope to limit.');
  return { proceed: true };
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const port = parseInt(process.env.REPOSCAPE_PORT || '5173', 10);

  if (await isPortInUse(port)) {
    console.error(
      `RepoScape (or another process) is already using port ${port}. ` +
        `Not starting a second instance. If this is a stale process, stop it first.`
    );
    process.exit(1);
  }

  const { generateSessionToken, unlinkStaleToken } = await import('./security.js');
  const { GraphCompiler } = await import('./compiler.js');
  const { createRoutes } = await import('./routes.js');
  const { HUDWebSocketServer } = await import('./websocket.js');
  const { FileWatcher } = await import('./watcher.js');

  await unlinkStaleToken(projectRoot);

  const compiler = new GraphCompiler(projectRoot);
  try {
    await compiler.init();
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }

  try {
    compiler.assertParserReady();
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }

  const guardResult = await projectSizeGuard(compiler, projectRoot);
  if (!guardResult.proceed) {
    process.exit(0);
  }

  const token = await generateSessionToken(projectRoot);
  console.log(`Session token saved to .reposcape/.session-token`);

  if (guardResult.scopeRoot) {
    compiler.setScopeRoot(guardResult.scopeRoot);
  }

  console.log('Compiling initial graph...');
  const graph = await compiler.compile();
  const scopeLabel = guardResult.scopeRoot
    ? ` (scoped: ${path.relative(projectRoot, guardResult.scopeRoot)}/)`
    : '';
  console.log(`Graph compiled: ${graph.nodes.length} nodes, ${graph.edges.length} edges${scopeLabel}`);

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  const staticDir = path.join(__dirname, '..', 'hud');
  try {
    await fs.access(staticDir);
    app.use(express.static(staticDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
          res.setHeader('Content-Type', 'application/javascript');
        }
      }
    }));
  } catch {
  }

  const { router, cleanup } = createRoutes(projectRoot, compiler, (diff) => {
    wsServer.broadcastDiff(diff);
  }, (event) => {
    wsServer.broadcastFocus(event);
  });
  app.use(router);

  const server = createServer(app);

  const wsServer = new HUDWebSocketServer(server, () => ({
    nodes: compiler.getNodes(),
    edges: compiler.getEdges(),
    hubNodes: Array.from(compiler.getHubNodes()),
  }));

  const watcher = new FileWatcher(projectRoot, compiler, (diff) => {
    wsServer.broadcastDiff(diff);
  }, guardResult.scopeRoot || undefined, (changedFiles) => {
    for (const file of changedFiles) {
      wsServer.broadcastFocus({ file, activity: 'edited' });
    }
  });
  watcher.start();

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Shutting down.`);
    } else {
      console.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    launchHUD(port, token);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down RepoScape...');
    cleanup();
    watcher.stop();
    wsServer.close();
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanup();
    watcher.stop();
    wsServer.close();
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
