import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'langchain';
import { z } from 'zod';
import { logger } from '../logger.js';

type SkillType = 'workflow' | 'personality' | 'context';

type Skill = {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  filePath: string;
};

const DEFAULT_SKILLS_DIR = path.join(process.cwd(), 'skills');

function getSkillDirs(): string[] {
  const configured =
    process.env.AGENT_SKILLS_DIRS ?? process.env.AGENT_SKILLS_DIR;
  const rawDirs = configured?.split(path.delimiter) ?? [DEFAULT_SKILLS_DIR];

  return rawDirs.map((dir) => path.resolve(dir)).filter(Boolean);
}

function parseFrontmatter(content: string): {
  metadata: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { metadata: {}, body: content.trim() };

  const metadata: Record<string, string> = {};
  for (const line of match[1]?.split('\n') ?? []) {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!entry) continue;

    const [, key, rawValue] = entry;
    if (!key) continue;

    metadata[key] = (rawValue ?? '').replace(/^['"]|['"]$/g, '').trim();
  }

  return {
    metadata,
    body: content.slice(match[0].length).trim(),
  };
}

async function loadSkill(filePath: string): Promise<Skill | null> {
  const content = await readFile(filePath, 'utf8');
  const { metadata, body } = parseFrontmatter(content);
  const name = metadata.name?.trim();
  const description = metadata.description?.trim();

  if (!name || !description) {
    logger.warn(`[skills] skipping ${filePath}: missing name or description`);
    return null;
  }

  const rawType = metadata.type?.trim().toLowerCase();
  const type: SkillType =
    rawType === 'personality' || rawType === 'context' ? rawType : 'workflow';

  return {
    name,
    description,
    type,
    body,
    filePath,
  };
}

async function discoverSkillFiles(): Promise<string[]> {
  const files: string[] = [];

  for (const dir of getSkillDirs()) {
    if (!existsSync(dir)) continue;

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      try {
        const skillStat = await stat(skillPath);
        if (skillStat.isFile()) files.push(skillPath);
      } catch {
        // Folder without SKILL.md is not a skill.
      }
    }
  }

  return files;
}

export async function loadSkills(): Promise<Skill[]> {
  const files = await discoverSkillFiles();
  const skills = await Promise.all(
    files.map(async (file) => {
      try {
        return await loadSkill(file);
      } catch (error) {
        logger.error(`[skills] failed to load ${file}`, error);
        return null;
      }
    }),
  );

  return skills
    .filter((skill): skill is Skill => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function buildSkillsSystemPrompt(): Promise<string> {
  const skills = await loadSkills();
  if (skills.length === 0) return '';

  const parts: string[] = [];

  const personalitySkills = skills.filter((s) => s.type === 'personality');
  const contextSkills = skills.filter((s) => s.type === 'context');
  const workflowSkills = skills.filter((s) => s.type === 'workflow');

  for (const skill of personalitySkills) {
    parts.push(skill.body);
  }

  for (const skill of contextSkills) {
    parts.push(`## ${skill.name}\n${skill.body}`);
  }

  if (workflowSkills.length > 0) {
    const catalog = workflowSkills
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join('\n');

    parts.push(`Skills:
The user can add project-local skills as skills/<skill-name>/SKILL.md. A skill is a named workflow or domain guide.
Available skills:
${catalog}

When a request clearly matches a skill description, call read_skill with that skill name before acting. Use only the relevant skill body; do not mention skills or internal routing to the user.`);
  }

  return parts.join('\n\n');
}

export const listSkills = tool(
  async () => {
    const skills = await loadSkills();
    return JSON.stringify(
      skills.map((skill) => ({
        name: skill.name,
        type: skill.type,
        description: skill.description,
      })),
    );
  },
  {
    name: 'list_skills',
    description:
      'List available project-local skills and their trigger descriptions.',
    schema: z.object({}),
  },
);

export const readSkill = tool(
  async ({ name }) => {
    const skills = await loadSkills();
    const normalizedName = name.trim().toLowerCase();
    const skill = skills.find(
      (candidate) => candidate.name.toLowerCase() === normalizedName,
    );

    if (!skill) {
      return `Skill not found: ${name}`;
    }

    return JSON.stringify({
      name: skill.name,
      description: skill.description,
      instructions: skill.body,
    });
  },
  {
    name: 'read_skill',
    description:
      'Read the full instructions for a project-local skill by skill name.',
    schema: z.object({
      name: z.string().describe('The skill name from the skill frontmatter.'),
    }),
  },
);

export const skillTools = [listSkills, readSkill];
