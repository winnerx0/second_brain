import { createAgent, tool } from 'langchain';
import { z } from 'zod';
import { model } from '../shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

export interface IntegrationModule {
  name: string;
  description: string;
  systemPrompt: string;
  requiredEnv?: string[];
  createTools(): AnyTool[];
  /** Override default sub-agent wrapping for integrations with custom dispatch logic. */
  buildTool?(): AnyTool;
}

const registry = new Map<string, IntegrationModule>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const agentCache = new Map<string, any>();

export function register(mod: IntegrationModule) {
  registry.set(mod.name, mod);
}

function getOrCreateAgent(mod: IntegrationModule) {
  if (!agentCache.has(mod.name)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentCache.set(mod.name, createAgent({ model, tools: mod.createTools() as any }));
  }
  return agentCache.get(mod.name)!;
}

export function buildIntegrationTool(name: string): AnyTool {
  const mod = registry.get(name);
  if (!mod) throw new Error(`No integration registered: ${name}`);
  if (mod.buildTool) return mod.buildTool();

  const agent = getOrCreateAgent(mod);

  return tool(
    async ({ query }: { query: string }) => {
      const response = await agent.invoke({
        messages: [
          { role: 'system', content: mod.systemPrompt },
          { role: 'user', content: query },
        ],
      });
      return response.messages[response.messages.length - 1]!.text;
    },
    {
      name: mod.name,
      description: mod.description,
      schema: z.object({ query: z.string() }),
    },
  );
}

export function getAllIntegrationTools(): AnyTool[] {
  return Array.from(registry.keys()).map(buildIntegrationTool);
}
