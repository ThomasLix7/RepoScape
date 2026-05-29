import fs from 'fs/promises';
import path from 'path';

export async function appendErrorLog(projectRoot: string, message: string): Promise<void> {
  const logPath = path.join(projectRoot, '.reposcape', 'error.log');

  await fs.mkdir(path.dirname(logPath), { recursive: true }).catch(() => {});

  try {
    const stat = await fs.stat(logPath);
    if (stat.size > 5 * 1024 * 1024) {
      await fs.rename(path.join(projectRoot, '.reposcape', 'error.log.2'), path.join(projectRoot, '.reposcape', 'error.log.3')).catch(() => {});
      await fs.rename(path.join(projectRoot, '.reposcape', 'error.log.1'), path.join(projectRoot, '.reposcape', 'error.log.2')).catch(() => {});
      await fs.rename(logPath, path.join(projectRoot, '.reposcape', 'error.log.1')).catch(() => {});
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  const timestamp = new Date().toISOString();
  await fs.appendFile(logPath, `[${timestamp}] ${message}\n`, 'utf-8');
}
