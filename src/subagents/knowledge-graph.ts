import { createAgent, tool } from 'langchain';
import z from 'zod';
import { model } from '../shared';
import { knowledgeGraphTools } from '../tools/knowledge-graph';

const KNOWLEDGE_GRAPH_SYSTEM_PROMPT = `You are a Knowledge Graph Assistant.

Your job is to build and query a structured graph of entities and relations.

Entity kinds: person, project, document, task, decision, topic, other

Available tools:
- upsert_graph_node: create/update nodes
- add_graph_fact: connect two entities with a relation edge
- search_graph_nodes: find likely entity nodes by name
- get_related_graph_context: fetch nearby graph context around an entity

Operating rules:
- Prefer add_graph_fact when a user states a relationship.
- Keep relation labels short, snake_case, and directional (depends_on, decided_in, mentions, blocked_by).
- Use evidence/source whenever the user provides it.
- For ambiguous entity references, search first.
- Return concise summaries, and when useful include a machine-readable JSON block.`;

const knowledgeGraphAgent = createAgent({
  model,
  tools: knowledgeGraphTools,
});

export const knowledgeGraphTool = tool(
  async ({ query }) => {
    const response = await knowledgeGraphAgent.invoke({
      messages: [
        { role: 'system', content: KNOWLEDGE_GRAPH_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    });
    return response.messages[response.messages.length - 1]!.text;
  },
  {
    name: 'knowledge_graph',
    description:
      'Build and query a personal knowledge graph of people, projects, docs, tasks, decisions, and topics.',
    schema: z.object({
      query: z
        .string()
        .describe(
          "Natural language request for knowledge graph operations (e.g., 'Add that Alice works on Project X', 'What do I know about the auth rewrite decision?', 'Connect the meeting notes to the sprint project')",
        ),
    }),
  },
);
