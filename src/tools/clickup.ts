import { tool } from 'langchain';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getValidToken } from '../oauth.js';

const CLICKUP_API = 'https://api.clickup.com/api/v2';

async function getToken(): Promise<string> {
  const token = await getValidToken('clickup');
  if (!token) throw new Error('ClickUp is not connected. Go to Connections and add your API key.');
  return token;
}

const headers = async (): Promise<Record<string, string>> => ({
  Authorization: await getToken(),
  'Content-Type': 'application/json',
});

// ─── Workspace / hierarchy ───────────────────────────────────────────────────

export const clickupGetWorkspaces = tool(
  async () => {
    try {
      const res = await fetch(`${CLICKUP_API}/team`, { headers: await headers() });
      if (!res.ok) return `Failed to get workspaces (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as { teams: Array<{ id: string; name: string; color: string }> };
      return JSON.stringify(data.teams.map((t) => ({ id: t.id, name: t.name })));
    } catch (err) {
      logger.error('[clickup] getWorkspaces', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_get_workspaces',
    description: 'Get all ClickUp workspaces the user belongs to. Returns workspace IDs and names. Call this first to get the workspace_id needed by other tools.',
    schema: z.object({}),
  },
);

export const clickupGetSpaces = tool(
  async ({ workspaceId }) => {
    try {
      const res = await fetch(`${CLICKUP_API}/team/${workspaceId}/space?archived=false`, { headers: await headers() });
      if (!res.ok) return `Failed to get spaces (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as { spaces: Array<{ id: string; name: string; private: boolean }> };
      return JSON.stringify(data.spaces.map((s) => ({ id: s.id, name: s.name, private: s.private })));
    } catch (err) {
      logger.error('[clickup] getSpaces', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_get_spaces',
    description: 'Get all spaces in a ClickUp workspace.',
    schema: z.object({
      workspaceId: z.string().describe('Workspace (team) ID'),
    }),
  },
);

export const clickupGetLists = tool(
  async ({ spaceId }) => {
    try {
      const [folderedRes, folderlessRes] = await Promise.all([
        fetch(`${CLICKUP_API}/space/${spaceId}/folder?archived=false`, { headers: await headers() }),
        fetch(`${CLICKUP_API}/space/${spaceId}/list?archived=false`, { headers: await headers() }),
      ]);

      const results: Array<{ id: string; name: string; folder?: string; taskCount: number }> = [];

      if (folderedRes.ok) {
        const fd = (await folderedRes.json()) as {
          folders: Array<{ id: string; name: string; lists: Array<{ id: string; name: string; task_count: number }> }>;
        };
        for (const folder of fd.folders) {
          for (const list of folder.lists) {
            results.push({ id: list.id, name: list.name, folder: folder.name, taskCount: list.task_count });
          }
        }
      }

      if (folderlessRes.ok) {
        const fl = (await folderlessRes.json()) as { lists: Array<{ id: string; name: string; task_count: number }> };
        for (const list of fl.lists) {
          results.push({ id: list.id, name: list.name, taskCount: list.task_count });
        }
      }

      return JSON.stringify(results);
    } catch (err) {
      logger.error('[clickup] getLists', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_get_lists',
    description: 'Get all lists in a ClickUp space (both foldered and folderless). Returns list IDs needed to get or create tasks.',
    schema: z.object({
      spaceId: z.string().describe('Space ID'),
    }),
  },
);

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const clickupGetTasks = tool(
  async ({ listId, status, assignee, dueDateLte, dueDateGte, page, includeSubtasks }) => {
    try {
      const url = new URL(`${CLICKUP_API}/list/${listId}/task`);
      url.searchParams.set('archived', 'false');
      if (status) url.searchParams.set('statuses[]', status);
      if (assignee) url.searchParams.set('assignees[]', assignee);
      if (dueDateLte) url.searchParams.set('due_date_lte', String(dueDateLte));
      if (dueDateGte) url.searchParams.set('due_date_gte', String(dueDateGte));
      if (page) url.searchParams.set('page', String(page));
      if (includeSubtasks) url.searchParams.set('subtasks', 'true');

      const res = await fetch(url.toString(), { headers: await headers() });
      if (!res.ok) return `Failed to get tasks (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as {
        tasks: Array<{
          id: string;
          name: string;
          status: { status: string };
          priority: { priority: string } | null;
          due_date: string | null;
          assignees: Array<{ username: string }>;
          description: string | null;
          url: string;
        }>;
        last_page: boolean;
      };

      const tasks = data.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status.status,
        priority: t.priority?.priority ?? null,
        dueDate: t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
        assignees: t.assignees.map((a) => a.username),
        description: t.description,
        url: t.url,
      }));

      return JSON.stringify({ tasks, lastPage: data.last_page });
    } catch (err) {
      logger.error('[clickup] getTasks', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_get_tasks',
    description: 'Get tasks in a ClickUp list. Supports filtering by status, assignee, and due date range.',
    schema: z.object({
      listId: z.string().describe('List ID'),
      status: z.string().optional().describe('Filter by status name (e.g. "in progress", "complete")'),
      assignee: z.string().optional().describe('Filter by assignee user ID'),
      dueDateLte: z.number().optional().describe('Filter tasks due on or before this Unix timestamp (ms)'),
      dueDateGte: z.number().optional().describe('Filter tasks due on or after this Unix timestamp (ms)'),
      page: z.number().optional().describe('Page number for pagination (default 0)'),
      includeSubtasks: z.boolean().optional().describe('Include subtasks in results'),
    }),
  },
);

export const clickupGetTask = tool(
  async ({ taskId }) => {
    try {
      const res = await fetch(`${CLICKUP_API}/task/${taskId}`, { headers: await headers() });
      if (!res.ok) return `Failed to get task (${res.status}): ${await res.text()}`;
      const t = (await res.json()) as {
        id: string;
        name: string;
        description: string | null;
        status: { status: string };
        priority: { priority: string } | null;
        due_date: string | null;
        assignees: Array<{ id: number; username: string; email: string }>;
        tags: Array<{ name: string }>;
        url: string;
        list: { id: string; name: string };
        parent: string | null;
        subtasks?: Array<{ id: string; name: string; status: { status: string } }>;
      };
      return JSON.stringify({
        id: t.id,
        name: t.name,
        description: t.description,
        status: t.status.status,
        priority: t.priority?.priority ?? null,
        dueDate: t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
        assignees: t.assignees.map((a) => ({ id: a.id, username: a.username, email: a.email })),
        tags: t.tags.map((tag) => tag.name),
        list: t.list,
        parent: t.parent,
        subtasks: t.subtasks?.map((s) => ({ id: s.id, name: s.name, status: s.status.status })),
        url: t.url,
      });
    } catch (err) {
      logger.error('[clickup] getTask', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_get_task',
    description: 'Get full details of a single ClickUp task by ID.',
    schema: z.object({
      taskId: z.string().describe('Task ID'),
    }),
  },
);

export const clickupCreateTask = tool(
  async ({ listId, name, description, status, priority, dueDate, assignees, tags, parentId }) => {
    try {
      const body: Record<string, unknown> = { name };
      if (description) body.description = description;
      if (status) body.status = status;
      if (priority !== undefined) body.priority = priority;
      if (dueDate) body.due_date = new Date(dueDate).getTime();
      if (assignees?.length) body.assignees = assignees;
      if (tags?.length) body.tags = tags;
      if (parentId) body.parent = parentId;

      const res = await fetch(`${CLICKUP_API}/list/${listId}/task`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) return `Failed to create task (${res.status}): ${await res.text()}`;
      const t = (await res.json()) as { id: string; url: string; name: string };
      return JSON.stringify({ id: t.id, name: t.name, url: t.url });
    } catch (err) {
      logger.error('[clickup] createTask', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_create_task',
    description: 'Create a new task in a ClickUp list.',
    schema: z.object({
      listId: z.string().describe('List ID to create the task in'),
      name: z.string().describe('Task name'),
      description: z.string().optional().describe('Task description (plain text)'),
      status: z.string().optional().describe('Status name (must match an existing status in the list)'),
      priority: z.number().int().min(1).max(4).optional().describe('Priority: 1=urgent, 2=high, 3=normal, 4=low'),
      dueDate: z.string().optional().describe('Due date as ISO 8601 string (e.g. "2026-05-10T00:00:00Z")'),
      assignees: z.array(z.number()).optional().describe('Array of user IDs to assign'),
      tags: z.array(z.string()).optional().describe('Array of tag names'),
      parentId: z.string().optional().describe('Parent task ID to create this as a subtask'),
    }),
  },
);

export const clickupUpdateTask = tool(
  async ({ taskId, name, description, status, priority, dueDate, assigneesAdd, assigneesRemove }) => {
    try {
      const body: Record<string, unknown> = {};
      if (name) body.name = name;
      if (description !== undefined) body.description = description;
      if (status) body.status = status;
      if (priority !== undefined) body.priority = priority;
      if (dueDate !== undefined) body.due_date = dueDate ? new Date(dueDate).getTime() : null;
      if (assigneesAdd?.length || assigneesRemove?.length) {
        body.assignees = {
          add: assigneesAdd ?? [],
          rem: assigneesRemove ?? [],
        };
      }

      const res = await fetch(`${CLICKUP_API}/task/${taskId}`, {
        method: 'PUT',
        headers: await headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) return `Failed to update task (${res.status}): ${await res.text()}`;
      const t = (await res.json()) as { id: string; url: string; name: string; status: { status: string } };
      return JSON.stringify({ id: t.id, name: t.name, status: t.status.status, url: t.url });
    } catch (err) {
      logger.error('[clickup] updateTask', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_update_task',
    description: 'Update an existing ClickUp task. Only include fields you want to change.',
    schema: z.object({
      taskId: z.string().describe('Task ID to update'),
      name: z.string().optional().describe('New task name'),
      description: z.string().optional().describe('New description (plain text)'),
      status: z.string().optional().describe('New status name'),
      priority: z.number().int().min(1).max(4).optional().describe('New priority: 1=urgent, 2=high, 3=normal, 4=low'),
      dueDate: z.string().optional().describe('New due date as ISO 8601, or empty string to clear it'),
      assigneesAdd: z.array(z.number()).optional().describe('User IDs to add as assignees'),
      assigneesRemove: z.array(z.number()).optional().describe('User IDs to remove from assignees'),
    }),
  },
);

export const clickupDeleteTask = tool(
  async ({ taskId }) => {
    try {
      const res = await fetch(`${CLICKUP_API}/task/${taskId}`, {
        method: 'DELETE',
        headers: await headers(),
      });
      if (!res.ok) return `Failed to delete task (${res.status}): ${await res.text()}`;
      return `Task ${taskId} deleted`;
    } catch (err) {
      logger.error('[clickup] deleteTask', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_delete_task',
    description: 'Permanently delete a ClickUp task.',
    schema: z.object({
      taskId: z.string().describe('Task ID to delete'),
    }),
  },
);

// ─── Search ──────────────────────────────────────────────────────────────────

export const clickupSearchTasks = tool(
  async ({ workspaceId, query, status, assignee, dueDateLte, dueDateGte }) => {
    try {
      const url = new URL(`${CLICKUP_API}/team/${workspaceId}/task`);
      if (query) url.searchParams.set('search', query);
      if (status) url.searchParams.set('statuses[]', status);
      if (assignee) url.searchParams.set('assignees[]', assignee);
      if (dueDateLte) url.searchParams.set('due_date_lte', String(dueDateLte));
      if (dueDateGte) url.searchParams.set('due_date_gte', String(dueDateGte));

      const res = await fetch(url.toString(), { headers: await headers() });
      if (!res.ok) return `Failed to search tasks (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as {
        tasks: Array<{
          id: string;
          name: string;
          status: { status: string };
          priority: { priority: string } | null;
          due_date: string | null;
          list: { name: string };
          url: string;
        }>;
      };
      const tasks = data.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status.status,
        priority: t.priority?.priority ?? null,
        dueDate: t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
        list: t.list.name,
        url: t.url,
      }));
      return JSON.stringify(tasks);
    } catch (err) {
      logger.error('[clickup] searchTasks', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_search_tasks',
    description: 'Search tasks across an entire ClickUp workspace by keyword, status, assignee, or due date.',
    schema: z.object({
      workspaceId: z.string().describe('Workspace (team) ID'),
      query: z.string().optional().describe('Keyword to search in task names and descriptions'),
      status: z.string().optional().describe('Filter by status name'),
      assignee: z.string().optional().describe('Filter by assignee user ID'),
      dueDateLte: z.number().optional().describe('Due on or before Unix timestamp (ms)'),
      dueDateGte: z.number().optional().describe('Due on or after Unix timestamp (ms)'),
    }),
  },
);

// ─── Comments ────────────────────────────────────────────────────────────────

export const clickupGetComments = tool(
  async ({ taskId }) => {
    try {
      const res = await fetch(`${CLICKUP_API}/task/${taskId}/comment`, { headers: await headers() });
      if (!res.ok) return `Failed to get comments (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as {
        comments: Array<{
          id: string;
          comment_text: string;
          user: { username: string };
          date: string;
        }>;
      };
      return JSON.stringify(
        data.comments.map((c) => ({
          id: c.id,
          text: c.comment_text,
          author: c.user.username,
          date: new Date(Number(c.date)).toISOString(),
        })),
      );
    } catch (err) {
      logger.error('[clickup] getComments', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_get_comments',
    description: 'Get all comments on a ClickUp task.',
    schema: z.object({
      taskId: z.string().describe('Task ID'),
    }),
  },
);

export const clickupCreateComment = tool(
  async ({ taskId, text }) => {
    try {
      const res = await fetch(`${CLICKUP_API}/task/${taskId}/comment`, {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({ comment_text: text }),
      });
      if (!res.ok) return `Failed to create comment (${res.status}): ${await res.text()}`;
      const data = (await res.json()) as { id: string };
      return `Comment created on task ${taskId}. Comment ID: ${data.id}`;
    } catch (err) {
      logger.error('[clickup] createComment', err);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  {
    name: 'clickup_create_comment',
    description: 'Add a comment to a ClickUp task.',
    schema: z.object({
      taskId: z.string().describe('Task ID'),
      text: z.string().describe('Comment text'),
    }),
  },
);

// ─── Export ──────────────────────────────────────────────────────────────────

export const clickupTools = [
  clickupGetWorkspaces,
  clickupGetSpaces,
  clickupGetLists,
  clickupGetTasks,
  clickupGetTask,
  clickupCreateTask,
  clickupUpdateTask,
  clickupDeleteTask,
  clickupSearchTasks,
  clickupGetComments,
  clickupCreateComment,
];
