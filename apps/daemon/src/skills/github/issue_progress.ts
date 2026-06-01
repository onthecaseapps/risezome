import type { Skill, SkillResult, SkillResultItem } from '../contract.js';
import type { GithubIssue } from '../../connectors/github/types.js';
import type { LiveSkillContext } from './live-context.js';
import { mapGithubError } from './error.js';

const NAME = 'github_issue_progress';

const LOAD_BEARING_EVENTS = new Set([
  'commented',
  'assigned',
  'unassigned',
  'labeled',
  'unlabeled',
  'closed',
  'reopened',
  'merged',
]);

const MAX_TIMELINE_EVENTS = 5;

/**
 * Timeline events from GitHub's /issues/{n}/timeline endpoint. The event
 * mix includes ~20 types; we filter to the load-bearing set above and
 * keep the 5 newest. Each event variant shapes its payload differently.
 */
interface TimelineEvent {
  readonly event?: string;
  readonly created_at?: string;
  readonly actor?: { readonly login: string };
  readonly user?: { readonly login: string };
  readonly label?: { readonly name: string };
  readonly assignee?: { readonly login: string };
  readonly body?: string;
  readonly html_url?: string;
}

export function buildIssueProgressSkill(ctx: LiveSkillContext): Skill {
  return {
    source: 'github',
    name: NAME,
    description:
      "Show recent activity on a specific GitHub issue or pull-request — current state, assignees, labels, and the last few timeline events (comments, label changes, assignment changes, state transitions). Use for 'have we made progress on issue 14', 'what's the status of issue 7', 'any movement on #42'. Hits the live GitHub API.",
    inputSchema: {
      type: 'object',
      properties: {
        issue_number: {
          type: 'integer',
          minimum: 1,
          description: 'The GitHub issue or pull-request number.',
        },
      },
      required: ['issue_number'],
    },
    handler: async (args): Promise<SkillResult> => {
      const issueNumber = Number(args.issue_number);
      try {
        const [issue, timeline] = await Promise.all([
          ctx.client.getJson<GithubIssue>(
            ctx.auth,
            `/repos/${ctx.repo.owner}/${ctx.repo.name}/issues/${issueNumber}`,
          ),
          ctx.client.getJson<readonly TimelineEvent[]>(
            ctx.auth,
            `/repos/${ctx.repo.owner}/${ctx.repo.name}/issues/${issueNumber}/timeline`,
          ),
        ]);
        return formatResult(issue, timeline);
      } catch (err) {
        throw mapGithubError(err, NAME);
      }
    },
  };
}

function formatResult(issue: GithubIssue, timeline: readonly TimelineEvent[]): SkillResult {
  const events = pickRecentEvents(timeline);
  const headline = buildHeadline(issue);
  if (events.length === 0) {
    return {
      kind: 'detail',
      summary: `${headline} No recent activity.`,
    };
  }
  const items: SkillResultItem[] = events.map(formatEvent);
  const eventNarrative = items.map((it) => it.title).join(' ');
  return {
    kind: 'detail',
    summary: `${headline} ${eventNarrative}`,
    items,
  };
}

function buildHeadline(issue: GithubIssue): string {
  const assignees = (issue.assignees ?? []).map((a) => a.login);
  const labels = (issue.labels ?? []).map((l) => l.name);
  const parts: string[] = [
    `Issue #${String(issue.number)} ("${issue.title}") is ${issue.state}`,
  ];
  if (assignees.length > 0) parts.push(`assigned to ${assignees.join(', ')}`);
  if (labels.length > 0) parts.push(`labeled ${labels.join(', ')}`);
  return parts.join('; ') + '.';
}

function pickRecentEvents(timeline: readonly TimelineEvent[]): TimelineEvent[] {
  const filtered = timeline.filter(
    (e) => typeof e.event === 'string' && LOAD_BEARING_EVENTS.has(e.event),
  );
  filtered.sort((a, b) => {
    const aT = typeof a.created_at === 'string' ? a.created_at : '';
    const bT = typeof b.created_at === 'string' ? b.created_at : '';
    return bT.localeCompare(aT);
  });
  return filtered.slice(0, MAX_TIMELINE_EVENTS);
}

function formatEvent(e: TimelineEvent): SkillResultItem {
  const actor = e.actor?.login ?? e.user?.login ?? 'someone';
  const when = typeof e.created_at === 'string' ? e.created_at : '';
  const item: SkillResultItem = {
    title: describeEvent(e, actor, when),
  };
  if (typeof e.html_url === 'string' && e.html_url.length > 0) {
    Object.assign(item, { url: e.html_url });
  }
  if (e.event === 'commented' && typeof e.body === 'string' && e.body.length > 0) {
    Object.assign(item, { subtitle: e.body.slice(0, 200) });
  }
  return item;
}

function describeEvent(e: TimelineEvent, actor: string, when: string): string {
  const suffix = when.length > 0 ? ` at ${when}` : '';
  switch (e.event) {
    case 'commented':
      return `${actor} commented${suffix}.`;
    case 'assigned':
      return `${actor} assigned ${e.assignee?.login ?? 'someone'}${suffix}.`;
    case 'unassigned':
      return `${actor} unassigned ${e.assignee?.login ?? 'someone'}${suffix}.`;
    case 'labeled':
      return `${actor} added label "${e.label?.name ?? '?'}"${suffix}.`;
    case 'unlabeled':
      return `${actor} removed label "${e.label?.name ?? '?'}"${suffix}.`;
    case 'closed':
      return `${actor} closed the issue${suffix}.`;
    case 'reopened':
      return `${actor} reopened the issue${suffix}.`;
    case 'merged':
      return `${actor} merged${suffix}.`;
    default:
      return `${e.event ?? 'event'} by ${actor}${suffix}.`;
  }
}
