import type { Condition, RuleConfig } from "./config.ts";
import type { JsonObject, Subject, WebhookContext } from "./types.ts";

export function getPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split(".")) {
    if (!segment) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function evaluateCondition(condition: Condition, root: unknown): boolean {
  const actual = getPath(root, condition.path);
  if (condition.exists !== undefined) return (actual !== undefined && actual !== null) === condition.exists;
  if (condition.equals !== undefined) return Object.is(actual, condition.equals);
  if (condition.not_equals !== undefined) return !Object.is(actual, condition.not_equals);
  if (condition.in !== undefined) return condition.in.some((expected) => Object.is(actual, expected));

  const expected = condition.contains ?? condition.not_contains;
  let contains: boolean;
  if (Array.isArray(actual)) {
    contains = actual.some((item) => Object.is(item, expected));
  } else if (typeof actual === "string") {
    const left = condition.ignore_case ? actual.toLocaleLowerCase() : actual;
    const rawRight = stringValue(expected);
    const right = condition.ignore_case ? rawRight.toLocaleLowerCase() : rawRight;
    contains = left.includes(right);
  } else {
    contains = false;
  }
  return condition.contains !== undefined ? contains : !contains;
}

export function conditionRoot(context: WebhookContext): JsonObject {
  return {
    ...context.payload,
    event: context.event,
    action: context.action,
    delivery_id: context.deliveryId,
    subject: context.subject,
  };
}

export function ruleMatches(rule: RuleConfig, context: WebhookContext): boolean {
  if (!rule.enabled || rule.on.event !== context.event) return false;
  if (rule.on.actions && !rule.on.actions.includes(context.action)) return false;
  if (rule.repositories && !rule.repositories.includes(context.repository)) return false;
  const root = conditionRoot(context);
  return rule.when.every((condition) => evaluateCondition(condition, root));
}

export function renderTemplate(template: string, root: unknown): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = getPath(root, path);
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    throw new Error(`Template value ${path} is not a scalar`);
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function subjectFromIssue(issue: Record<string, unknown>, pullRequest = false): Subject {
  const number = Number(issue.number ?? 0);
  return {
    type: pullRequest || issue.pull_request !== undefined ? "pull_request" : "issue",
    number,
    title: text(issue.title),
    body: text(issue.body),
    ...(text(issue.html_url) ? { url: text(issue.html_url) } : {}),
  };
}

export function buildContext(input: {
  deliveryId: string;
  event: string;
  action: string;
  payload: JsonObject;
}): WebhookContext {
  const repository = object(input.payload.repository);
  const installation = object(input.payload.installation);
  const fullName = text(repository?.full_name);
  if (!fullName) throw new Error("Webhook payload is missing repository.full_name");
  const installationId = Number(installation?.id ?? 0);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error("Webhook payload is missing a valid installation.id");
  }

  let subject: Subject;
  const issue = object(input.payload.issue);
  const pullRequest = object(input.payload.pull_request);
  if (pullRequest) subject = subjectFromIssue(pullRequest, true);
  else if (issue) subject = subjectFromIssue(issue);
  else {
    subject = {
      type: "repository",
      number: 0,
      title: fullName,
      body: "",
      ...(text(repository?.html_url) ? { url: text(repository?.html_url) } : {}),
    };
  }

  return {
    deliveryId: input.deliveryId,
    event: input.event,
    action: input.action,
    payload: input.payload,
    repository: fullName,
    installationId,
    subject,
  };
}

export function parentRunFromPayload(payload: JsonObject): string | null {
  const comment = object(payload.comment);
  const review = object(payload.review);
  const body = text(comment?.body) || text(review?.body);
  const match = /<!--\s*gerry:run=([a-zA-Z0-9_-]+)\s*-->/.exec(body);
  return match?.[1] ?? null;
}

export function templateRoot(
  context: WebhookContext,
  runId: string,
  workspacePath: string,
  workflow: { id: string; type: string } | null = null,
): JsonObject {
  return {
    ...conditionRoot(context),
    run: { id: runId },
    workflow: workflow ? { id: workflow.id, type: workflow.type } : {},
    workspace: { path: workspacePath },
  };
}
