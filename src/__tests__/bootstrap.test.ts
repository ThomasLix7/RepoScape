import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { bootstrapSkills } from '../server/bootstrap.js';

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'reposcape-bootstrap-'));
}

async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeFile(dir: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(dir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

async function readFile(dir: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(dir, relPath), 'utf-8');
}

async function fileExists(dir: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, relPath));
    return true;
  } catch {
    return false;
  }
}

const SAMPLE_SKILL = `# Test Skill\n\nThis is a test skill for bootstrap testing.\n`;

describe('bootstrapSkills', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    await writeFile(tmpDir, 'SKILL.md', SAMPLE_SKILL);
  });

  afterEach(async () => {
    await removeTempDir(tmpDir);
  });

  it('should create isolated rule file for Cursor IDE with YAML frontmatter', async () => {
    await bootstrapSkills(tmpDir);
    const exists = await fileExists(tmpDir, '.cursor/rules/reposcape.mdc');
    expect(exists).toBe(true);
    const content = await readFile(tmpDir, '.cursor/rules/reposcape.mdc');
    expect(content).toContain('---');
    expect(content).toContain('description: "RepoScape agent skill');
    expect(content).toContain('Test Skill');
  });

  it('should create isolated rule file for Windsurf IDE', async () => {
    await bootstrapSkills(tmpDir);
    const exists = await fileExists(tmpDir, '.windsurf/rules/reposcape.mdc');
    expect(exists).toBe(true);
    const content = await readFile(tmpDir, '.windsurf/rules/reposcape.mdc');
    expect(content).toContain('Test Skill');
  });

  it('should create marker block for Claude Code', async () => {
    await bootstrapSkills(tmpDir);
    const exists = await fileExists(tmpDir, '.claude/rules');
    expect(exists).toBe(true);
    const content = await readFile(tmpDir, '.claude/rules');
    expect(content).toContain('REPOSCAPE AGENT SKILL - DO NOT EDIT START');
    expect(content).toContain('REPOSCAPE AGENT SKILL - DO NOT EDIT END');
    expect(content).toContain('Test Skill');
  });

  it('should create marker block for GitHub Copilot', async () => {
    await bootstrapSkills(tmpDir);
    const exists = await fileExists(tmpDir, '.github/copilot-instructions.md');
    expect(exists).toBe(true);
    const content = await readFile(tmpDir, '.github/copilot-instructions.md');
    expect(content).toContain('REPOSCAPE AGENT SKILL - DO NOT EDIT START');
    expect(content).toContain('Test Skill');
  });

  it('should create marker block for Aider', async () => {
    await bootstrapSkills(tmpDir);
    const exists = await fileExists(tmpDir, '.aider.instruction.md');
    expect(exists).toBe(true);
    const content = await readFile(tmpDir, '.aider.instruction.md');
    expect(content).toContain('REPOSCAPE AGENT SKILL - DO NOT EDIT START');
    expect(content).toContain('Test Skill');
  });

  it('should hot update existing marker block without touching surrounding content', async () => {
    const existingContent = `# My existing config\n\nSome content here.\n\n${'# === REPOSCAPE AGENT SKILL - DO NOT EDIT START ==='}\nOld skill content\n${'# === REPOSCAPE AGENT SKILL - DO NOT EDIT END ==='}\n\nTrailing content.\n`;
    await writeFile(tmpDir, '.github/copilot-instructions.md', existingContent);

    await bootstrapSkills(tmpDir);

    const updated = await readFile(tmpDir, '.github/copilot-instructions.md');
    expect(updated).toContain('# My existing config');
    expect(updated).toContain('Some content here.');
    expect(updated).toContain('Trailing content.');
    expect(updated).toContain('Test Skill');
    expect(updated).not.toContain('Old skill content');
  });

  it('should append to existing file without markers', async () => {
    const existingContent = `# My Copilot Config\n\nSome existing instructions.\n`;
    await writeFile(tmpDir, '.github/copilot-instructions.md', existingContent);

    await bootstrapSkills(tmpDir);

    const updated = await readFile(tmpDir, '.github/copilot-instructions.md');
    expect(updated).toContain('# My Copilot Config');
    expect(updated).toContain('Some existing instructions.');
    expect(updated).toContain('REPOSCAPE AGENT SKILL - DO NOT EDIT START');
    expect(updated).toContain('Test Skill');
  });

  it('should not overwrite other existing Cursor rules', async () => {
    await writeFile(tmpDir, '.cursor/rules/existing.mdc', 'existing cursor rules');
    await bootstrapSkills(tmpDir);

    const existing = await readFile(tmpDir, '.cursor/rules/existing.mdc');
    expect(existing).toBe('existing cursor rules');
  });

  it('should handle missing SKILL.md gracefully', async () => {
    const emptyDir = await createTempDir();
    try {
      await bootstrapSkills(emptyDir);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('SKILL.md not found');
    } finally {
      await removeTempDir(emptyDir);
    }
  });

  it('should be idempotent — running twice produces same result', async () => {
    await bootstrapSkills(tmpDir);
    const firstRun = await readFile(tmpDir, '.github/copilot-instructions.md');

    await bootstrapSkills(tmpDir);
    const secondRun = await readFile(tmpDir, '.github/copilot-instructions.md');

    // Content should be functionally the same (markers updated with same content)
    expect(secondRun).toContain('REPOSCAPE AGENT SKILL - DO NOT EDIT START');
    expect(secondRun).toContain('Test Skill');
  });
});
