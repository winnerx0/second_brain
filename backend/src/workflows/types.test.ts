import { describe, test, expect } from 'bun:test';
import {
  validateDefinition,
  nextOccurrence,
  latestOccurrence,
  checkPermission,
  isReadTool,
  type Definition,
} from './types.js';

const definition: Definition = {
  name: 'Briefing',
  description: '',
  instructions: 'Summarize every weekday',
  trigger: {
    kind: 'cron',
    cron: '0 8 * * 1-5',
    at: null,
    timezone: 'Africa/Lagos',
  },
  steps: [
    {
      id: 'summary',
      title: 'Summarize',
      specialist: 'synthesis',
      instruction: 'Summarize evidence',
      dependsOn: [],
      permissions: [],
    },
  ],
};
describe('workflow schedules', () => {
  test('weekday schedule respects Lagos timezone and skips weekends', () => {
    expect(
      nextOccurrence(
        definition.trigger,
        new Date('2026-10-02T07:01:00Z'),
      )?.toISOString(),
    ).toBe('2026-10-05T07:00:00.000Z');
  });
  test('coalesces a missed schedule to the latest occurrence', () => {
    expect(
      latestOccurrence(
        definition.trigger,
        new Date('2026-10-06T12:00:00Z'),
      ).toISOString(),
    ).toBe('2026-10-06T07:00:00.000Z');
  });
  test('daily schedules adjust UTC offset across daylight saving', () => {
    const trigger = {
      ...definition.trigger,
      timezone: 'America/New_York',
      cron: '0 8 * * *',
    };
    expect(
      nextOccurrence(trigger, new Date('2026-03-07T14:00:00Z'))?.toISOString(),
    ).toBe('2026-03-08T12:00:00.000Z');
    expect(
      nextOccurrence(trigger, new Date('2026-10-31T13:00:00Z'))?.toISOString(),
    ).toBe('2026-11-01T13:00:00.000Z');
  });
  test('one-time schedules finish and manual schedules never enqueue', () => {
    expect(
      nextOccurrence({ kind: 'manual', cron: null, at: null, timezone: 'UTC' }),
    ).toBeNull();
    expect(
      nextOccurrence({
        kind: 'once',
        cron: null,
        at: '2020-01-01T00:00:00Z',
        timezone: 'UTC',
      }),
    ).toBeNull();
  });
  test('rejects invalid cron, timezone, duplicate IDs and cycles', () => {
    expect(() =>
      validateDefinition({
        ...definition,
        trigger: { ...definition.trigger, cron: '* * * * * *' },
      }),
    ).toThrow();
    expect(() =>
      validateDefinition({
        ...definition,
        trigger: { ...definition.trigger, timezone: 'Mars/Base' },
      }),
    ).toThrow();
    expect(() =>
      validateDefinition({
        ...definition,
        steps: [...definition.steps, ...definition.steps],
      }),
    ).toThrow();
    expect(() =>
      validateDefinition({
        ...definition,
        steps: [{ ...definition.steps[0], dependsOn: ['summary'] }],
      }),
    ).toThrow();
  });
});
describe('workflow action scope', () => {
  test('recognizes specialist read operations', () => {
    for (const name of [
      'readDocument',
      'spotify_get_profile',
      'clickup_get_tasks',
      'get_calendar_events',
    ])
      expect(isReadTool(name)).toBe(true);
    expect(isReadTool('send_email')).toBe(false);
  });
  test('denies unapproved actions and mismatched or unconstrained targets', () => {
    const step = {
      ...definition.steps[0]!,
      permissions: [
        { tool: 'send_email', constraints: { to: ['alice@example.com'] } },
      ],
    };
    expect(() =>
      checkPermission(step, 'send_email', {
        to: 'alice@example.com',
        body: 'Hello',
      }),
    ).not.toThrow();
    expect(() =>
      checkPermission(step, 'send_email', { to: 'bob@example.com' }),
    ).toThrow();
    expect(() =>
      checkPermission(step, 'send_email', {
        to: 'alice@example.com',
        bcc: 'bob@example.com',
      }),
    ).toThrow();
    expect(() =>
      checkPermission(step, 'delete_issue', { issueNumber: 3 }),
    ).toThrow();
  });
});
