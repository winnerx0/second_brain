import { tool } from "langchain";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { logger } from "../logger.ts";
import { OpenAI } from "openai";
import { config } from "../config.ts";
import { memories, memoryCleanupRuns } from "../db/schema.ts";
import { ChatOpenRouter } from "@langchain/openrouter";

const embeddingClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
const debateModel = new ChatOpenRouter({
  apiKey: config.OPENROUTER_API_KEY,
  baseURL: config.OPENROUTER_BASE_URL,
  model: "openai/gpt-oss-120b:free",
  temperature: 0.1,
  maxRetries: 2,
});

const classifications = [
  "identity",
  "relationships",
  "behavior",
  "preferences",
  "corrections",
  "knowledge",
  "unclassified",
] as const;

type Classification = (typeof classifications)[number];
type Tier = "short_term" | "long_term" | "lifelong";
type Action = "keep" | "delete" | "merge" | "upgrade" | "downgrade";

type MemoryRow = typeof memories.$inferSelect;

const minImportanceByClassification: Record<Classification, number> = {
  identity: 0.9,
  relationships: 0.7,
  behavior: 0.7,
  corrections: 0.8,
  preferences: 0.4,
  knowledge: 0.4,
  unclassified: 0.2,
};

const defaultImportanceByClassification: Record<Classification, number> = {
  identity: 0.9,
  relationships: 0.8,
  behavior: 0.8,
  corrections: 0.8,
  preferences: 0.5,
  knowledge: 0.5,
  unclassified: 0.2,
};

const tierByClassification: Record<Classification, Tier> = {
  identity: "lifelong",
  relationships: "lifelong",
  behavior: "lifelong",
  preferences: "long_term",
  corrections: "long_term",
  knowledge: "long_term",
  unclassified: "short_term",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeImportance(
  classification: Classification,
  rawImportance?: number,
): number {
  const floor = minImportanceByClassification[classification];
  const candidate = rawImportance ?? defaultImportanceByClassification[classification];
  return clamp(Math.max(floor, candidate), 0.2, 0.9);
}

function computeExpiresAt(tier: Tier, from: Date): Date | null {
  if (tier === "lifelong") return null;

  const days = tier === "short_term" ? 7 : 30;
  const expires = new Date(from);
  expires.setUTCDate(expires.getUTCDate() + days);
  return expires;
}

function inferClassificationFromText(content: string): Classification {
  const value = content.toLowerCase();

  if (/\b(correction|actually|instead|not\s+.+\s+but|i said earlier)\b/.test(value)) {
    return "corrections";
  }

  if (/\b(my name is|i am\s+\d+|i live in|i work as|i work at|my birthday|my age)\b/.test(value)) {
    return "identity";
  }

  if (/\b(my manager|my boss|my sister|my brother|my friend|my wife|my husband|my partner|my colleague)\b/.test(value)) {
    return "relationships";
  }

  if (/\b(always|never|tone|style|do not|dont|respond like|when you reply)\b/.test(value)) {
    return "behavior";
  }

  if (/\b(prefer|preference|likes|dislikes|favorite|concise|short answers|dark mode|i use)\b/.test(value)) {
    return "preferences";
  }

  if (/\b(i know|i understand|i learned|i am experienced|expert in|familiar with)\b/.test(value)) {
    return "knowledge";
  }

  return "unclassified";
}

const classificationDebateSchema = z.object({
  classification: z.enum(classifications),
  suggested_importance: z.number().min(0.2).max(0.9),
  reasoning: z.string(),
});

const memoryFactSplitSchema = z.object({
  facts: z.array(z.string()).min(1).max(10),
});

const debateOutputSchema = z.object({
  action: z.enum(["keep", "delete", "merge", "upgrade", "downgrade"]),
  suggested_importance: z.number().min(0.2).max(0.9),
  reasoning: z.string(),
});

type DebateOutput = z.infer<typeof debateOutputSchema>;

function toLogPayload(value: unknown, maxLength = 1600): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxLength) return serialized;
    return `${serialized.slice(0, maxLength)}...<truncated>`;
  } catch {
    const text = String(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...<truncated>`;
  }
}

function fallbackDebateOutput(memory: MemoryRow, reason: string): DebateOutput {
  return {
    action: "keep",
    suggested_importance: normalizeImportance(
      memory.classification as Classification,
      memory.importance,
    ),
    reasoning: `Fallback decision used because debate output was invalid: ${reason}`,
  };
}

async function embed(input: string): Promise<number[]> {
  const res = await embeddingClient.embeddings.create({
    model: config.EMBEDDING_MODEL,
    input,
  });
  return res.data[0]!.embedding;
}

function buildQueryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3),
    ),
  ).slice(0, 6);
}

function asDebateHistory(history: unknown): unknown[] {
  return Array.isArray(history) ? history : [];
}

async function findRelatedMemories(memory: MemoryRow, limit = 5): Promise<MemoryRow[]> {
  const embedding = await embed(memory.content);
  const rows = await db
    .select()
    .from(memories)
    .where(ne(memories.id, memory.id))
    .orderBy(sql`vector <=> ${JSON.stringify(embedding)}::vector`)
    .limit(limit);

  return rows;
}

function semanticConflictLikely(correction: string, existing: string): boolean {
  const c = correction.toLowerCase();
  const e = existing.toLowerCase();

  if (c === e) return true;

  const mentionsCorrection = /\b(actually|instead|not|correction|i said earlier)\b/.test(c);
  if (!mentionsCorrection) return false;

  const words = new Set(c.split(/\W+/).filter(Boolean));
  const overlap = e
    .split(/\W+/)
    .filter(Boolean)
    .filter((w) => words.has(w)).length;

  return overlap >= 3;
}

async function classifyWhenAmbiguous(content: string): Promise<{
  classification: Classification;
  importance: number;
  reasoning: string;
}> {
  const structured = debateModel.withStructuredOutput(classificationDebateSchema);
  const result = await structured.invoke([
    [
      "system",
      "You classify a memory for an agent memory system. Choose the best classification and a practical importance score based on criticality to agent correctness.",
    ],
    [
      "human",
      [
        "Return only the structured response.",
        "",
        "Classification options:",
        "identity | relationships | behavior | preferences | corrections | knowledge | unclassified",
        "",
        `Memory: ${content}`,
      ].join("\n"),
    ],
  ]);

  const classification = result.classification;
  const importance = normalizeImportance(classification, result.suggested_importance);

  logger.info(
    `[memory.model] classification.decision=${toLogPayload({
      content,
      classification,
      suggested_importance: result.suggested_importance,
      normalized_importance: importance,
      reasoning: result.reasoning,
    })}`,
  );

  return {
    classification,
    importance,
    reasoning: result.reasoning,
  };
}

function extractTextFromModelOutput(output: unknown): string {
  if (!output) return "";
  if (typeof output === "string") return output;

  if (typeof output === "object") {
    const maybeObj = output as {
      content?: unknown;
      text?: unknown;
      facts?: unknown;
    };

    if (typeof maybeObj.text === "string") return maybeObj.text;
    if (typeof maybeObj.content === "string") return maybeObj.content;

    if (Array.isArray(maybeObj.content)) {
      const text = maybeObj.content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const maybePart = part as { text?: unknown };
          return typeof maybePart.text === "string" ? maybePart.text : "";
        })
        .filter(Boolean)
        .join("\n");

      if (text) return text;
    }

    if (Array.isArray(maybeObj.facts)) {
      return JSON.stringify({ facts: maybeObj.facts });
    }
  }

  return "";
}

function parseFactsFromModelText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const tryParseJson = (value: string): string[] => {
    try {
      const parsed = JSON.parse(value) as { facts?: unknown };
      if (!parsed || !Array.isArray(parsed.facts)) return [];
      return parsed.facts
        .filter((fact): fact is string => typeof fact === "string")
        .map((fact) => fact.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const directJson = tryParseJson(trimmed);
  if (directJson.length > 0) return directJson;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    const fencedJson = tryParseJson(fencedMatch[1]);
    if (fencedJson.length > 0) return fencedJson;
  }

  // Last-resort heuristic for non-JSON model outputs.
  return trimmed
    .split(/\n|;|\s+\band\b\s+/i)
    .map((part) => part.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 10);
}

function parseDebateOutputFromModelText(text: string): DebateOutput | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const parseCandidate = (candidate: unknown): DebateOutput | null => {
    if (!candidate || typeof candidate !== "object") return null;

    const record = candidate as {
      action?: unknown;
      suggested_importance?: unknown;
      importance?: unknown;
      reasoning?: unknown;
    };

    const action =
      typeof record.action === "string"
        ? (record.action.trim().toLowerCase() as Action)
        : undefined;

    const rawImportance =
      typeof record.suggested_importance === "number"
        ? record.suggested_importance
        : typeof record.suggested_importance === "string"
          ? Number(record.suggested_importance)
          : typeof record.importance === "number"
            ? record.importance
            : typeof record.importance === "string"
              ? Number(record.importance)
              : NaN;

    const reasoning =
      typeof record.reasoning === "string" && record.reasoning.trim().length > 0
        ? record.reasoning.trim()
        : "Recovered from raw model output";

    const normalized = {
      action,
      suggested_importance: clamp(Number.isFinite(rawImportance) ? rawImportance : 0.5, 0.2, 0.9),
      reasoning,
    };

    const parsed = debateOutputSchema.safeParse(normalized);
    return parsed.success ? parsed.data : null;
  };

  const tryParseJson = (value: string): DebateOutput | null => {
    try {
      return parseCandidate(JSON.parse(value));
    } catch {
      return null;
    }
  };

  const direct = tryParseJson(trimmed);
  if (direct) return direct;

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    const fenced = tryParseJson(fencedMatch[1]);
    if (fenced) return fenced;
  }

  const objectLike = trimmed.match(/\{[\s\S]*\}/);
  if (objectLike?.[0]) {
    const extracted = tryParseJson(objectLike[0]);
    if (extracted) return extracted;
  }

  const actionMatch = trimmed.match(/\b(keep|delete|merge|upgrade|downgrade)\b/i);
  if (!actionMatch) return null;

  const importanceMatch = trimmed.match(/(?:suggested_importance|importance)\s*[:=]\s*([0-9]*\.?[0-9]+)/i);
  const reasoningMatch = trimmed.match(/reasoning\s*[:=]\s*([\s\S]+)/i);

  const heuristic = debateOutputSchema.safeParse({
    action: actionMatch[1]?.toLowerCase(),
    suggested_importance: clamp(importanceMatch?.[1] ? Number(importanceMatch[1]) : 0.5, 0.2, 0.9),
    reasoning: reasoningMatch?.[1]?.trim() || "Recovered from heuristic parse",
  });

  return heuristic.success ? heuristic.data : null;
}

async function splitMemoryIntoFacts(content: string): Promise<string[]> {
  const messages: ["system" | "human", string][] = [
    [
      "system",
      [
        "Split user memory text into atomic facts when it contains multiple stable facts.",
        "Each fact must stand alone and keep original meaning.",
        "Do not invent details.",
        "If only one stable fact exists, return a single-item array.",
        "Return JSON only with shape: {\"facts\":[\"fact 1\",\"fact 2\"]}.",
      ].join("\n"),
    ],
    [
      "human",
      [
        "Memory text:",
        content,
      ].join("\n"),
    ],
  ];

  let cleaned: string[] = [];

  try {
    const structured = debateModel.withStructuredOutput(memoryFactSplitSchema);
    const structuredResult = await structured.invoke(messages);
    logger.info(
      `[memory.model] fact_split.structured=${toLogPayload({ content, result: structuredResult })}`,
    );
    const maybeFacts = structuredResult?.facts;

    if (Array.isArray(maybeFacts)) {
      cleaned = maybeFacts
        .filter((fact): fact is string => typeof fact === "string")
        .map((fact) => fact.trim())
        .filter(Boolean);
    }
  } catch {
    // Intentionally fall through to a plain-model parsing strategy.
  }

  if (cleaned.length === 0) {
    const fallbackOutput = await debateModel.invoke(messages);
    logger.info(
      `[memory.model] fact_split.fallback_raw=${toLogPayload({
        content,
        output: extractTextFromModelOutput(fallbackOutput),
      })}`,
    );
    const text = extractTextFromModelOutput(fallbackOutput);
    cleaned = parseFactsFromModelText(text);
  }

  logger.info(
    `[memory.model] fact_split.decision=${toLogPayload({ content, facts: cleaned })}`,
  );

  if (cleaned.length === 0) {
    return [content.trim()];
  }

  return cleaned;
}

async function applyCorrectionOverride(newMemory: MemoryRow): Promise<number[]> {
  const related = await findRelatedMemories(newMemory, 10);
  const conflicts = related.filter((candidate) =>
    semanticConflictLikely(newMemory.content, candidate.content),
  );

  if (conflicts.length === 0) return [];

  const ids = conflicts.map((m) => m.id);
  await db.delete(memories).where(inArray(memories.id, ids));

  const historyEntry = {
    type: "correction_override",
    at: new Date().toISOString(),
    replaced_memory_ids: ids,
  };

  await db
    .update(memories)
    .set({
      debateHistory: [...asDebateHistory(newMemory.debateHistory), historyEntry],
      updatedAt: new Date(),
    })
    .where(eq(memories.id, newMemory.id));

  return ids;
}

function tierRank(tier: Tier): number {
  if (tier === "lifelong") return 3;
  if (tier === "long_term") return 2;
  return 1;
}

function morePermanentTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

async function runDebateAgent(
  role: "advocate" | "skeptic" | "judge",
  memory: MemoryRow,
  related: MemoryRow[],
  context: string,
): Promise<DebateOutput> {
  const structured = debateModel.withStructuredOutput(debateOutputSchema);
  const promptMessages: ["system" | "human", string][] = [
    [
      "system",
      [
        `You are the ${role} in a memory lifecycle debate.`,
        "Make a decision from: keep | delete | merge | upgrade | downgrade.",
        "Use practical lifecycle judgment from recency, importance, access_count, and redundancy.",
        "Return only the structured output.",
      ].join("\n"),
    ],
    [
      "human",
      [
        "Memory under review:",
        JSON.stringify(
          {
            id: memory.id,
            content: memory.content,
            classification: memory.classification,
            tier: memory.tier,
            importance: memory.importance,
            access_count: memory.accessCount,
            last_accessed_at: memory.lastAccessedAt,
          },
          null,
          2,
        ),
        "",
        "Related memories:",
        JSON.stringify(
          related.map((r) => ({
            id: r.id,
            content: r.content,
            classification: r.classification,
            tier: r.tier,
            importance: r.importance,
            access_count: r.accessCount,
            last_accessed_at: r.lastAccessedAt,
          })),
          null,
          2,
        ),
        "",
        "Transcript/context:",
        context,
      ].join("\n"),
    ],
  ];

  try {
    const response = await structured.invoke(promptMessages);

    logger.info(
      `[memory.model] lifecycle.${role}.raw=${toLogPayload({ memoryId: memory.id, response })}`,
    );

    const parsed = debateOutputSchema.safeParse(response);
    if (parsed.success) {
      logger.info(
        `[memory.model] lifecycle.${role}.decision=${toLogPayload({
          memoryId: memory.id,
          decision: parsed.data,
        })}`,
      );
      return parsed.data;
    }

    logger.warn(
      `[memory.lifecycle] ${role} returned invalid structured output: ${parsed.error.message}`,
    );

    const rawResponse = await debateModel.invoke(promptMessages);
    const rawText = extractTextFromModelOutput(rawResponse);
    logger.info(
      `[memory.model] lifecycle.${role}.raw_recovery=${toLogPayload({ memoryId: memory.id, rawText })}`,
    );

    const recovered = parseDebateOutputFromModelText(rawText);
    if (recovered) {
      logger.info(
        `[memory.model] lifecycle.${role}.recovered_decision=${toLogPayload({
          memoryId: memory.id,
          decision: recovered,
        })}`,
      );
      return recovered;
    }

    const fallback = fallbackDebateOutput(memory, parsed.error.message);
    logger.info(
      `[memory.model] lifecycle.${role}.fallback=${toLogPayload({ memoryId: memory.id, fallback })}`,
    );
    return fallback;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[memory.lifecycle] ${role} debate invocation failed: ${message}`);
    const fallback = fallbackDebateOutput(memory, message);
    logger.info(
      `[memory.model] lifecycle.${role}.fallback=${toLogPayload({ memoryId: memory.id, fallback })}`,
    );
    return fallback;
  }
}

async function decideWithDebate(memory: MemoryRow): Promise<{
  verdict: DebateOutput;
  transcript: unknown[];
}> {
  const related = await findRelatedMemories(memory, 5);

  const advocateRound1 = await runDebateAgent(
    "advocate",
    memory,
    related,
    "Round 1 opening.",
  );

  const skepticRound1 = await runDebateAgent(
    "skeptic",
    memory,
    related,
    `Advocate round 1: ${JSON.stringify(advocateRound1)}`,
  );

  const transcript: unknown[] = [
    { round: 1, role: "advocate", output: advocateRound1 },
    { round: 1, role: "skeptic", output: skepticRound1 },
  ];

  logger.info(
    `[memory.model] lifecycle.round1=${toLogPayload({
      memoryId: memory.id,
      advocate: advocateRound1,
      skeptic: skepticRound1,
    })}`,
  );

  if (advocateRound1.action === skepticRound1.action) {
    logger.info(
      `[memory.model] lifecycle.verdict=${toLogPayload({ memoryId: memory.id, verdict: skepticRound1 })}`,
    );
    return { verdict: skepticRound1, transcript };
  }

  const advocateRound2 = await runDebateAgent(
    "advocate",
    memory,
    related,
    [
      `Advocate round 1: ${JSON.stringify(advocateRound1)}`,
      `Skeptic round 1: ${JSON.stringify(skepticRound1)}`,
      "Round 2: revise based on disagreement.",
    ].join("\n"),
  );

  const skepticRound2 = await runDebateAgent(
    "skeptic",
    memory,
    related,
    [
      `Advocate round 1: ${JSON.stringify(advocateRound1)}`,
      `Skeptic round 1: ${JSON.stringify(skepticRound1)}`,
      `Advocate round 2: ${JSON.stringify(advocateRound2)}`,
      "Round 2: final counter.",
    ].join("\n"),
  );

  transcript.push(
    { round: 2, role: "advocate", output: advocateRound2 },
    { round: 2, role: "skeptic", output: skepticRound2 },
  );

  logger.info(
    `[memory.model] lifecycle.round2=${toLogPayload({
      memoryId: memory.id,
      advocate: advocateRound2,
      skeptic: skepticRound2,
    })}`,
  );

  if (advocateRound2.action === skepticRound2.action) {
    logger.info(
      `[memory.model] lifecycle.verdict=${toLogPayload({ memoryId: memory.id, verdict: skepticRound2 })}`,
    );
    return { verdict: skepticRound2, transcript };
  }

  const judge = await runDebateAgent(
    "judge",
    memory,
    related,
    `Full transcript:\n${JSON.stringify(transcript, null, 2)}`,
  );

  transcript.push({ round: 3, role: "judge", output: judge });
  logger.info(
    `[memory.model] lifecycle.judge=${toLogPayload({ memoryId: memory.id, judge })}`,
  );
  logger.info(
    `[memory.model] lifecycle.verdict=${toLogPayload({ memoryId: memory.id, verdict: judge })}`,
  );
  return { verdict: judge, transcript };
}

async function applyLifecycleDecision(memory: MemoryRow, action: Action, suggestedImportance: number, transcript: unknown[]) {
  const now = new Date();
  const existingHistory = asDebateHistory(memory.debateHistory);
  const historyEntry = {
    type: "lifecycle_debate",
    at: now.toISOString(),
    action,
    suggested_importance: suggestedImportance,
    transcript,
  };

  if (action === "delete") {
    await db.delete(memories).where(eq(memories.id, memory.id));
    return "deleted";
  }

  if (action === "keep") {
    await db
      .update(memories)
      .set({
        debateHistory: [...existingHistory, historyEntry],
        updatedAt: now,
      })
      .where(eq(memories.id, memory.id));
    return "kept";
  }

  if (action === "upgrade") {
    const nextImportance = normalizeImportance(
      memory.classification as Classification,
      Math.max(memory.importance, suggestedImportance),
    );

    const nextTier: Tier =
      memory.tier === "short_term" ? "long_term" : (memory.tier as Tier);

    await db
      .update(memories)
      .set({
        importance: nextImportance,
        tier: nextTier,
        promotedAt: memory.tier === "short_term" ? now : memory.promotedAt,
        expiresAt: computeExpiresAt(nextTier, now),
        debateHistory: [...existingHistory, historyEntry],
        updatedAt: now,
      })
      .where(eq(memories.id, memory.id));

    return "upgraded";
  }

  if (action === "downgrade") {
    const nextImportance = clamp(suggestedImportance, 0.2, 0.9);

    if (nextImportance < 0.3) {
      await db.delete(memories).where(eq(memories.id, memory.id));
      return "deleted_after_downgrade";
    }

    await db
      .update(memories)
      .set({
        importance: nextImportance,
        debateHistory: [...existingHistory, historyEntry],
        updatedAt: now,
      })
      .where(eq(memories.id, memory.id));

    return "downgraded";
  }

  const related = await findRelatedMemories(memory, 1);
  const peer = related[0];

  if (!peer) {
    await db
      .update(memories)
      .set({
        debateHistory: [...existingHistory, historyEntry],
        updatedAt: now,
      })
      .where(eq(memories.id, memory.id));
    return "kept_no_merge_target";
  }

  const mergedTier = morePermanentTier(memory.tier as Tier, peer.tier as Tier);
  const mergedImportance = Math.max(memory.importance, peer.importance);
  const mergedLastAccessed =
    new Date(memory.lastAccessedAt) > new Date(peer.lastAccessedAt)
      ? memory.lastAccessedAt
      : peer.lastAccessedAt;

  const mergedContent = `${memory.content}\n${peer.content}`;
  const mergedEmbedding = await embed(mergedContent);

  await db
    .update(memories)
    .set({
      content: mergedContent,
      tier: mergedTier,
      importance: mergedImportance,
      accessCount: memory.accessCount + peer.accessCount,
      lastAccessedAt: mergedLastAccessed,
      expiresAt: computeExpiresAt(mergedTier, mergedLastAccessed),
      vector: sql`${JSON.stringify(mergedEmbedding)}::vector`,
      debateHistory: [
        ...existingHistory,
        {
          ...historyEntry,
          merged_ids: [memory.id, peer.id],
        },
      ],
      updatedAt: now,
    })
    .where(eq(memories.id, memory.id));

  await db.delete(memories).where(eq(memories.id, peer.id));
  return "merged";
}

export async function runMemoryLifecycleReview() {
  const now = new Date();
  const shortTermCutoff = new Date(now);
  shortTermCutoff.setUTCDate(shortTermCutoff.getUTCDate() - 7);

  const longTermCutoff = new Date(now);
  longTermCutoff.setUTCDate(longTermCutoff.getUTCDate() - 30);

  const shortCandidates = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.tier, "short_term"),
        lt(memories.lastAccessedAt, shortTermCutoff),
        lt(memories.accessCount, 5),
      ),
    )
    .orderBy(desc(memories.lastAccessedAt));

  const longCandidates = await db
    .select()
    .from(memories)
    .where(and(eq(memories.tier, "long_term"), lt(memories.lastAccessedAt, longTermCutoff)))
    .orderBy(desc(memories.lastAccessedAt));

  const candidates = [...shortCandidates, ...longCandidates];

  const summary = {
    reviewed: candidates.length,
    autoDeleted: 0,
    autoKept: 0,
    debated: 0,
    mergedRows: 0,
    deletedRows: 0,
    promotedRows: 0,
    decisions: [] as string[],
  };

  for (const memory of candidates) {
    if (memory.importance < 0.3) {
      await db.delete(memories).where(eq(memories.id, memory.id));
      summary.autoDeleted += 1;
      summary.deletedRows += 1;
      summary.decisions.push(`memory:${memory.id}:auto_delete`);
      continue;
    }

    if (memory.importance > 0.6) {
      summary.autoKept += 1;
      summary.decisions.push(`memory:${memory.id}:auto_keep`);
      continue;
    }

    summary.debated += 1;

    try {
      const { verdict, transcript } = await decideWithDebate(memory);
      const action = await applyLifecycleDecision(
        memory,
        verdict.action,
        verdict.suggested_importance,
        transcript,
      );

      if (action === "merged") {
        summary.mergedRows += 1;
      }

      if (action === "deleted" || action === "deleted_after_downgrade") {
        summary.deletedRows += 1;
      }

      if (action === "upgraded") {
        summary.promotedRows += 1;
      }

      summary.decisions.push(`memory:${memory.id}:${action}`);
    } catch (error) {
      logger.error("[memory.lifecycle] debate failed", error);
      summary.decisions.push(`memory:${memory.id}:debate_failed_keep`);
    }
  }

  await db.insert(memoryCleanupRuns).values({
    ranAt: now,
    reviewedRows: summary.reviewed,
    mergedRows: summary.mergedRows,
    deletedRows: summary.deletedRows,
    promotedRows: summary.promotedRows,
  });

  logger.info(`[memory.lifecycle] ${JSON.stringify(summary)}`);
  return summary;
}

export const storeMemory = tool(
  async ({ value, query, classification, importance }) => {
    try {
      logger.info(`[memory] storing value=${value}`);

      let facts: string[];
      try {
        facts = await splitMemoryIntoFacts(value);
      } catch (error) {
        logger.warn(`[memory] fact split failed, falling back to single memory: ${error instanceof Error ? error.message : String(error)}`);
        facts = [value.trim()];
      }

      const insertedSummaries: string[] = [];
      const replacedByCorrections = new Set<number>();

      for (const fact of facts) {
        const history: unknown[] = [];

        let finalClassification: Classification;
        let finalImportance: number;

        if (classification) {
          finalClassification = classification;
          finalImportance = normalizeImportance(classification, importance);
        } else {
          try {
            const debated = await classifyWhenAmbiguous(fact);
            finalClassification = debated.classification;
            finalImportance = normalizeImportance(finalClassification, debated.importance);
            history.push({
              type: "classification_debate",
              at: new Date().toISOString(),
              reasoning: debated.reasoning,
              classification: finalClassification,
              suggested_importance: finalImportance,
            });
          } catch (error) {
            const inferred = inferClassificationFromText(fact);
            finalClassification = inferred;
            finalImportance = normalizeImportance(inferred, importance);
            history.push({
              type: "classification_fallback",
              at: new Date().toISOString(),
              reason: error instanceof Error ? error.message : String(error),
              classification: finalClassification,
            });
          }
        }

        if (finalClassification === "identity") {
          finalImportance = 0.9;
        }

        const tier = tierByClassification[finalClassification];
        const now = new Date();
        const expiresAt = computeExpiresAt(tier, now);
        const embedding = await embed(query || fact);

        const [inserted] = await db
          .insert(memories)
          .values({
            content: fact,
            classification: finalClassification,
            tier,
            importance: finalImportance,
            accessCount: 0,
            createdAt: now,
            lastAccessedAt: now,
            expiresAt,
            promotedAt: null,
            debateHistory: history,
            metadata: {
              source_query: query ?? value,
              source_input: value,
              split_count: facts.length,
            },
            vector: sql`${JSON.stringify(embedding)}::vector`,
            updatedAt: now,
          })
          .returning();

        if (!inserted) {
          continue;
        }

        if (finalClassification === "corrections") {
          const replacedIds = await applyCorrectionOverride(inserted);
          for (const replacedId of replacedIds) {
            replacedByCorrections.add(replacedId);
          }
        }

        insertedSummaries.push(
          `id=${inserted.id}, class=${finalClassification}, tier=${tier}, importance=${finalImportance.toFixed(2)}`,
        );
      }

      if (insertedSummaries.length === 0) {
        return "Error storing memory: insert failed";
      }

      const correctionResult =
        replacedByCorrections.size > 0
          ? `; replaced conflicting memories: ${Array.from(replacedByCorrections).join(", ")}`
          : "";

      return `Stored ${insertedSummaries.length} memory row(s): ${insertedSummaries.join(" | ")}${correctionResult}`;
    } catch (error) {
      logger.error("[memory]", error);
      return `Error storing memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "store_memory",
    description:
      "Store a memory with classification-aware tiering, scoring, and correction override support.",
    schema: z.object({
      value: z.string().describe("Memory content"),
      query: z.string().optional().describe("Optional retrieval text used for embedding"),
      classification: z
        .enum(classifications)
        .optional()
        .describe("Optional override classification"),
      importance: z.number().min(0.2).max(0.9).optional(),
    }),
  },
);

export const recallMemories = tool(
  async ({ query }) => {
    try {
      logger.info(`[memory] recalling query=${query}`);

      const queryEmbedding = await embed(query);

      const queryTerms = buildQueryTerms(query);

      const lexicalMatches =
        queryTerms.length > 0
          ? await db
              .select()
              .from(memories)
              .where(
                or(
                  ...queryTerms.map((term) =>
                    ilike(memories.content, `%${term}%`),
                  ),
                ),
              )
              .orderBy(sql`vector <=> ${JSON.stringify(queryEmbedding)}::vector`)
              .limit(5)
          : [];

      const result =
        lexicalMatches.length > 0
          ? lexicalMatches
          : await db
              .select()
              .from(memories)
              .orderBy(sql`vector <=> ${JSON.stringify(queryEmbedding)}::vector`)
              .limit(5);

      const now = new Date();

      for (const row of result) {
        const nextCount = row.accessCount + 1;
        const promote = row.tier === "short_term" && nextCount >= 5;
        const nextTier: Tier = promote ? "long_term" : (row.tier as Tier);

        await db
          .update(memories)
          .set({
            accessCount: nextCount,
            tier: nextTier,
            promotedAt: promote ? now : row.promotedAt,
            lastAccessedAt: now,
            expiresAt: computeExpiresAt(nextTier, now),
            updatedAt: now,
          })
          .where(eq(memories.id, row.id));
      }

      return {
        memories: result.map((r) => ({
          id: r.id,
          content: r.content,
          classification: r.classification,
          tier: r.tier,
          importance: r.importance,
          accessCount: r.accessCount + 1,
        })),
      };
    } catch (error) {
      logger.error("[memory]", error);
      return `Error recalling memories: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "recall_memories",
    description:
      "Retrieve top memories by semantic relevance, update access counters, and auto-promote proven short-term memories.",
    schema: z.object({
      query: z.string().describe("Semantic query for recall"),
    }),
  },
);

export const deleteMemory = tool(
  async ({ id, key, query }) => {
    try {
      if (id) {
        await db.delete(memories).where(eq(memories.id, id));
        return `Deleted memory id=${id}`;
      }

      const text = query ?? key;
      if (!text) {
        return "Error deleting memory: provide id, query, or key";
      }

      const qEmbedding = await embed(text);
      const [candidate] = await db
        .select()
        .from(memories)
        .orderBy(sql`vector <=> ${JSON.stringify(qEmbedding)}::vector`)
        .limit(1);

      if (!candidate) {
        return "No memory found to delete";
      }

      await db.delete(memories).where(eq(memories.id, candidate.id));
      return `Deleted memory id=${candidate.id}`;
    } catch (error) {
      logger.error("[memory]", error);
      return `Error deleting memory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  {
    name: "delete_memory",
    description: "Delete a memory by id or by semantic match.",
    schema: z.object({
      id: z.number().int().min(1).optional().describe("Specific memory id to delete"),
      query: z.string().optional().describe("Semantic text to locate memory to delete"),
      key: z
        .string()
        .optional()
        .describe("Legacy alias for query; kept for backward compatibility"),
    }),
  },
);
