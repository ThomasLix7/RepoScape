import fs from 'fs/promises';
import path from 'path';

const MARKER_START = '# ====================================================\n# === REPOSCAPE AGENT SKILL - DO NOT EDIT START ===\n# ====================================================';
const MARKER_END = '# ====================================================\n# === REPOSCAPE AGENT SKILL - DO NOT EDIT END ===\n# ====================================================';

interface PlatformTarget {
  name: string;
  path: string;
  strategy: 'isolated' | 'marker';
  yamlFrontmatter?: string;
}

const PLATFORMS: PlatformTarget[] = [
  {
    name: 'Cursor IDE',
    path: '.cursor/rules/reposcape.mdc',
    strategy: 'isolated',
    yamlFrontmatter: '---\ndescription: "RepoScape agent skill for codebase graph analysis"\nglobs:\nalwaysApply: false\n---\n',
  },
  {
    name: 'Windsurf IDE',
    path: '.windsurf/rules/reposcape.mdc',
    strategy: 'isolated',
  },
  {
    name: 'Claude Code',
    path: '.claude/rules',
    strategy: 'marker',
  },
  {
    name: 'GitHub Copilot',
    path: '.github/copilot-instructions.md',
    strategy: 'marker',
  },
  {
    name: 'Aider / OpenCode',
    path: '.aider.instruction.md',
    strategy: 'marker',
  },
];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readSkillContent(projectRoot: string): Promise<string> {
  const skillPath = path.join(projectRoot, 'SKILL.md');
  try {
    return await fs.readFile(skillPath, 'utf-8');
  } catch {
    throw new Error(`SKILL.md not found at ${skillPath}. Run this command from the project root.`);
  }
}

function wrapWithMarkers(content: string): string {
  return `${MARKER_START}\n${content}\n${MARKER_END}`;
}

function hasMarkers(content: string): boolean {
  return content.includes('REPOSCAPE AGENT SKILL - DO NOT EDIT START') &&
    content.includes('REPOSCAPE AGENT SKILL - DO NOT EDIT END');
}

function replaceMarkerContent(content: string, newBlock: string): string {
  const startIdx = content.indexOf('REPOSCAPE AGENT SKILL - DO NOT EDIT START');
  const endMarker = 'REPOSCAPE AGENT SKILL - DO NOT EDIT END';
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) return content;

  // Find the start of the start marker line
  const lineStart = content.lastIndexOf('\n', startIdx);
  const blockStart = lineStart >= 0 ? lineStart + 1 : 0;

  // Find the end of the end marker line
  const endLineEnd = content.indexOf('\n', endIdx + endMarker.length);
  const blockEnd = endLineEnd >= 0 ? endLineEnd + 1 : content.length;

  return content.slice(0, blockStart) + newBlock + '\n' + content.slice(blockEnd);
}

// §8.B: Isolated rule file creation (Cursor, Windsurf)
// Always writes directly — no symlinks. This ensures YAML frontmatter
// is present and avoids EEXIST errors on re-run.
async function writeIsolatedFile(
  projectRoot: string,
  target: PlatformTarget,
  skillContent: string
): Promise<void> {
  const filePath = path.join(projectRoot, target.path);
  const dir = path.dirname(filePath);

  await fs.mkdir(dir, { recursive: true });

  const fileContent = target.yamlFrontmatter
    ? target.yamlFrontmatter + skillContent
    : skillContent;

  // Check if file already exists with identical content
  const exists = await fileExists(filePath);
  if (exists) {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (existing === fileContent) {
      console.log(`  ✓ ${target.name}: ${target.path} (unchanged)`);
      return;
    }
  }

  // §8.D: Direct write — handles Windows without symlink permission issues
  // and preserves YAML frontmatter for .mdc files
  await fs.writeFile(filePath, fileContent, 'utf-8');
  console.log(`  ✓ ${target.name}: ${target.path}${exists ? ' (updated)' : ''}`);
}

// §8.C: Marker block injection (Claude, Copilot, Aider)
async function writeMarkerBlock(
  projectRoot: string,
  target: PlatformTarget,
  skillContent: string
): Promise<void> {
  const filePath = path.join(projectRoot, target.path);
  const dir = path.dirname(filePath);

  // Ensure directory exists
  if (dir !== projectRoot) {
    await fs.mkdir(dir, { recursive: true });
  }

  const block = wrapWithMarkers(skillContent);

  const exists = await fileExists(filePath);

  if (!exists) {
    // File doesn't exist — write block directly
    await fs.writeFile(filePath, block + '\n', 'utf-8');
    console.log(`  ✓ ${target.name}: created ${target.path}`);
    return;
  }

  // File exists — check for markers
  const existing = await fs.readFile(filePath, 'utf-8');

  if (hasMarkers(existing)) {
    // Hot update: replace only content between markers
    const updated = replaceMarkerContent(existing, block);
    await fs.writeFile(filePath, updated, 'utf-8');
    console.log(`  ✓ ${target.name}: updated ${target.path} (hot update)`);
  } else {
    // Safe append: add block to end of file
    const separator = existing.endsWith('\n') ? '' : '\n';
    await fs.writeFile(filePath, existing + separator + block + '\n', 'utf-8');
    console.log(`  ✓ ${target.name}: appended to ${target.path}`);
  }
}

export async function bootstrapSkills(projectRoot: string): Promise<void> {
  console.log('\n🔧 RepoScape Skill Bootstrap\n');

  const skillContent = await readSkillContent(projectRoot);

  for (const target of PLATFORMS) {
    try {
      if (target.strategy === 'isolated') {
        await writeIsolatedFile(projectRoot, target, skillContent);
      } else {
        await writeMarkerBlock(projectRoot, target, skillContent);
      }
    } catch (err: any) {
      console.error(`  ✗ ${target.name}: ${err.message}`);
    }
  }

  console.log('\nDone! Agent skills installed for all detected platforms.');
  console.log('Re-run `npx reposcape --bootstrap` after updating SKILL.md.\n');
}
