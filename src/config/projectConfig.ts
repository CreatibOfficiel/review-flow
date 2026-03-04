import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition } from '@/entities/progress/agentDefinition.type.js';
import type { Language } from '@/entities/language/language.schema.js';

/**
 * Project-specific review configuration
 * Located in each project's .claude/reviews/config.json
 */
export interface ProjectConfig {
  github: boolean;
  gitlab: boolean;
  defaultModel: 'sonnet' | 'opus';
  reviewSkill: string;
  reviewFollowupSkill: string;
  reviewFixSkill?: string;
  language: Language;
  agents?: AgentDefinition[];
  followupAgents?: AgentDefinition[];
  fixAgents?: AgentDefinition[];
  maxFixIterations?: number;
  autoFix?: boolean;
}

/**
 * Validate agents array structure
 */
function validateAgents(agents: unknown): agents is AgentDefinition[] {
  if (!Array.isArray(agents)) {
    return false;
  }

  return agents.every((agent) => {
    if (agent === null || typeof agent !== 'object') {
      return false;
    }
    const record = agent as Record<string, unknown>;
    const name = record.name;
    const displayName = record.displayName;
    return (
      typeof name === 'string' &&
      typeof displayName === 'string' &&
      name.length > 0 &&
      displayName.length > 0
    );
  });
}

/**
 * Load project configuration from .claude/reviews/config.json
 * @param localPath - Path to the project root directory
 * @returns ProjectConfig or undefined if file doesn't exist
 * @throws Error if file exists but is invalid
 */
export function loadProjectConfig(localPath: string): ProjectConfig | undefined {
  const configPath = join(localPath, '.claude', 'reviews', 'config.json');

  if (!existsSync(configPath)) {
    return undefined;
  }

  const rawContent = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(rawContent) as Record<string, unknown>;

  // Validate required fields
  const requiredFields = ['github', 'gitlab', 'defaultModel', 'reviewSkill', 'reviewFollowupSkill'];
  for (const field of requiredFields) {
    if (!(field in parsed)) {
      throw new Error(`Project config missing required field: ${field}`);
    }
  }

  // Validate agents if present
  if ('agents' in parsed && parsed.agents !== undefined) {
    if (!validateAgents(parsed.agents)) {
      throw new Error(
        'Invalid agents format: must be array of { name: string, displayName: string }'
      );
    }
  }

  // Validate followupAgents if present
  if ('followupAgents' in parsed && parsed.followupAgents !== undefined) {
    if (!validateAgents(parsed.followupAgents)) {
      throw new Error(
        'Invalid followupAgents format: must be array of { name: string, displayName: string }'
      );
    }
  }

  // Validate fixAgents if present
  if ('fixAgents' in parsed && parsed.fixAgents !== undefined) {
    if (!validateAgents(parsed.fixAgents)) {
      throw new Error(
        'Invalid fixAgents format: must be array of { name: string, displayName: string }'
      );
    }
  }

  return {
    github: Boolean(parsed.github),
    gitlab: Boolean(parsed.gitlab),
    defaultModel: parsed.defaultModel === 'opus' ? 'opus' : 'sonnet',
    reviewSkill: String(parsed.reviewSkill),
    reviewFollowupSkill: String(parsed.reviewFollowupSkill),
    reviewFixSkill: parsed.reviewFixSkill ? String(parsed.reviewFixSkill) : undefined,
    language: parsed.language === 'fr' ? 'fr' : 'en',
    agents: parsed.agents as AgentDefinition[] | undefined,
    followupAgents: parsed.followupAgents as AgentDefinition[] | undefined,
    fixAgents: parsed.fixAgents as AgentDefinition[] | undefined,
    maxFixIterations: typeof parsed.maxFixIterations === 'number' ? parsed.maxFixIterations : undefined,
    autoFix: typeof parsed.autoFix === 'boolean' ? parsed.autoFix : undefined,
  };
}

/**
 * Get agents from project config or undefined for defaults
 */
export function getProjectAgents(localPath: string): AgentDefinition[] | undefined {
  try {
    const config = loadProjectConfig(localPath);
    return config?.agents;
  } catch {
    return undefined;
  }
}

/**
 * Get language from project config, defaulting to 'en'
 */
export function getProjectLanguage(localPath: string): Language {
  try {
    const config = loadProjectConfig(localPath);
    return config?.language ?? 'en';
  } catch {
    return 'en';
  }
}

/**
 * Get followup agents from project config or undefined for defaults
 */
export function getFollowupAgents(localPath: string): AgentDefinition[] | undefined {
  try {
    const config = loadProjectConfig(localPath);
    return config?.followupAgents;
  } catch {
    return undefined;
  }
}

/**
 * Get fix agents from project config or undefined for defaults
 */
export function getFixAgents(localPath: string): AgentDefinition[] | undefined {
  try {
    const config = loadProjectConfig(localPath);
    return config?.fixAgents;
  } catch {
    return undefined;
  }
}

/**
 * Get max fix iterations from project config, defaulting to 5
 */
export function getMaxFixIterations(localPath: string): number {
  try {
    const config = loadProjectConfig(localPath);
    return config?.maxFixIterations ?? 5;
  } catch {
    return 5;
  }
}
