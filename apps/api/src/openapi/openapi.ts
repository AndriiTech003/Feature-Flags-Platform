import { z, type ZodType } from 'zod';
import * as c from '@ashamrai/flags-contracts';

export interface RouteDoc {
  summary: string;
  tag: string;
  body?: ZodType;
  query?: ZodType;
  public?: boolean;
}

const patchBody = z.union([c.patchRequestSchema, c.instructionListSchema]);

export const routeDocs: Record<string, RouteDoc> = {
  'GET /health': { summary: 'Liveness and dependency check', tag: 'system', public: true },
  'GET /openapi.json': { summary: 'OpenAPI document', tag: 'system', public: true },
  'GET /docs': { summary: 'Swagger UI', tag: 'system', public: true },
  'POST /auth/signup': {
    summary: 'Create a user and its organization',
    tag: 'auth',
    body: c.signupSchema,
    public: true,
  },
  'POST /auth/login': {
    summary: 'Log in with email and password',
    tag: 'auth',
    body: c.loginSchema,
    public: true,
  },
  'POST /auth/logout': { summary: 'Log out (client discards the token)', tag: 'auth' },
  'GET /auth/me': { summary: 'Current user and organizations', tag: 'auth' },
  'POST /auth/refresh': { summary: 'Issue a fresh token', tag: 'auth' },
  'GET /auth/github': { summary: 'Start GitHub OAuth (when configured)', tag: 'auth', public: true },
  'GET /auth/github/callback': { summary: 'GitHub OAuth callback', tag: 'auth', public: true },
  'GET /orgs': { summary: 'List organizations of the current user', tag: 'organizations' },
  'POST /orgs': { summary: 'Create an organization', tag: 'organizations', body: c.createOrganizationSchema },
  'GET /orgs/{org}/members': { summary: 'List members', tag: 'organizations' },
  'POST /orgs/{org}/members': { summary: 'Add a member', tag: 'organizations', body: c.inviteMemberSchema },
  'PATCH /orgs/{org}/members/{userId}': {
    summary: 'Change member role',
    tag: 'organizations',
    body: c.updateMemberSchema,
  },
  'DELETE /orgs/{org}/members/{userId}': { summary: 'Remove a member', tag: 'organizations' },
  'GET /projects': { summary: 'List projects', tag: 'projects' },
  'POST /projects': {
    summary: 'Create a project with default environments',
    tag: 'projects',
    body: c.createProjectSchema,
  },
  'GET /projects/{p}': { summary: 'Get a project', tag: 'projects' },
  'PATCH /projects/{p}': { summary: 'Rename a project', tag: 'projects', body: c.updateProjectSchema },
  'DELETE /projects/{p}': { summary: 'Delete a project', tag: 'projects' },
  'GET /projects/{p}/environments': { summary: 'List environments', tag: 'environments' },
  'POST /projects/{p}/environments': {
    summary: 'Create an environment',
    tag: 'environments',
    body: c.createEnvironmentSchema,
  },
  'PATCH /projects/{p}/environments/{env}': {
    summary: 'Update an environment (require approval, color)',
    tag: 'environments',
    body: c.updateEnvironmentSchema,
  },
  'DELETE /projects/{p}/environments/{env}': { summary: 'Delete an environment', tag: 'environments' },
  'GET /projects/{p}/flags': {
    summary: 'List flags with per-environment state and stale indicator',
    tag: 'flags',
  },
  'POST /projects/{p}/flags': { summary: 'Create a flag', tag: 'flags', body: c.createFlagSchema },
  'GET /projects/{p}/flags/{key}': { summary: 'Get a flag with all environment configs', tag: 'flags' },
  'PATCH /projects/{p}/flags/{key}': {
    summary: 'Update flag definition, archive or restore',
    tag: 'flags',
    body: c.updateFlagSchema,
  },
  'DELETE /projects/{p}/flags/{key}': { summary: 'Delete an archived flag', tag: 'flags' },
  'GET /projects/{p}/flags/{key}/envs/{env}': {
    summary: 'Get flag configuration in an environment (ETag = version)',
    tag: 'flags',
  },
  'PATCH /projects/{p}/flags/{key}/envs/{env}': {
    summary: 'Semantic patch with If-Match version, 409 on conflict',
    tag: 'flags',
    body: patchBody,
  },
  'POST /projects/{p}/flags/{key}/copy': {
    summary: 'Copy configuration between environments with diff preview',
    tag: 'flags',
    body: c.copyConfigSchema,
  },
  'GET /projects/{p}/flags/{key}/insights': {
    summary: 'Evaluations by variation for 24h / 7d and last evaluation',
    tag: 'insights',
  },
  'GET /projects/{p}/compare': { summary: 'Compare flag configurations across environments', tag: 'flags' },
  'GET /projects/{p}/envs/{env}/ruleset': { summary: 'Ruleset for the evaluation playground', tag: 'flags' },
  'GET /projects/{p}/context-attributes': {
    summary: 'Context attributes observed by the relay',
    tag: 'flags',
  },
  'POST /projects/{p}/flags/{key}/envs/{env}/change-requests': {
    summary: 'Request approval for a change',
    tag: 'change requests',
    body: c.createChangeRequestSchema,
  },
  'GET /projects/{p}/change-requests': { summary: 'List change requests', tag: 'change requests' },
  'GET /change-requests/{id}': { summary: 'Change request with diff preview', tag: 'change requests' },
  'POST /change-requests/{id}/approve': {
    summary: 'Approve a change request',
    tag: 'change requests',
    body: c.reviewChangeRequestSchema,
  },
  'POST /change-requests/{id}/reject': {
    summary: 'Reject a change request',
    tag: 'change requests',
    body: c.reviewChangeRequestSchema,
  },
  'POST /change-requests/{id}/apply': { summary: 'Apply an approved change request', tag: 'change requests' },
  'POST /projects/{p}/flags/{key}/envs/{env}/schedule': {
    summary: 'Schedule a change',
    tag: 'scheduled changes',
    body: c.createScheduledChangeSchema,
  },
  'GET /projects/{p}/scheduled-changes': { summary: 'List scheduled changes', tag: 'scheduled changes' },
  'DELETE /scheduled-changes/{id}': { summary: 'Cancel a scheduled change', tag: 'scheduled changes' },
  'GET /projects/{p}/envs/{env}/segments': { summary: 'List segments', tag: 'segments' },
  'POST /projects/{p}/envs/{env}/segments': {
    summary: 'Create a segment',
    tag: 'segments',
    body: c.createSegmentSchema,
  },
  'GET /projects/{p}/envs/{env}/segments/{key}': { summary: 'Get a segment', tag: 'segments' },
  'PATCH /projects/{p}/envs/{env}/segments/{key}': {
    summary: 'Update a segment (If-Match version)',
    tag: 'segments',
    body: c.updateSegmentSchema,
  },
  'DELETE /projects/{p}/envs/{env}/segments/{key}': { summary: 'Delete an unused segment', tag: 'segments' },
  'GET /projects/{p}/envs/{env}/sdk-keys': { summary: 'List SDK keys', tag: 'sdk keys' },
  'POST /projects/{p}/envs/{env}/sdk-keys': {
    summary: 'Create an SDK key (shown once)',
    tag: 'sdk keys',
    body: c.createSdkKeySchema,
  },
  'POST /projects/{p}/envs/{env}/sdk-keys/{id}/rotate': {
    summary: 'Rotate a key keeping the old one valid for a grace period',
    tag: 'sdk keys',
    body: c.rotateSdkKeySchema,
  },
  'DELETE /projects/{p}/envs/{env}/sdk-keys/{id}': { summary: 'Revoke a key immediately', tag: 'sdk keys' },
  'GET /projects/{p}/audit-log': { summary: 'Audit log with diffs', tag: 'audit', query: c.auditQuerySchema },
  'GET /projects/{p}/metrics': { summary: 'List metrics', tag: 'experiments' },
  'POST /projects/{p}/metrics': {
    summary: 'Create a metric',
    tag: 'experiments',
    body: c.createMetricSchema,
  },
  'GET /projects/{p}/metrics/{key}': { summary: 'Get a metric', tag: 'experiments' },
  'PATCH /projects/{p}/metrics/{key}': {
    summary: 'Update a metric',
    tag: 'experiments',
    body: c.updateMetricSchema,
  },
  'DELETE /projects/{p}/metrics/{key}': { summary: 'Delete a metric', tag: 'experiments' },
  'GET /projects/{p}/experiments': { summary: 'List experiments', tag: 'experiments' },
  'POST /projects/{p}/experiments': {
    summary: 'Create an experiment',
    tag: 'experiments',
    body: c.createExperimentSchema,
  },
  'GET /projects/{p}/experiments/{key}': { summary: 'Get an experiment', tag: 'experiments' },
  'PATCH /projects/{p}/experiments/{key}': {
    summary: 'Update an experiment',
    tag: 'experiments',
    body: c.updateExperimentSchema,
  },
  'DELETE /projects/{p}/experiments/{key}': { summary: 'Delete a stopped experiment', tag: 'experiments' },
  'POST /experiments/{id}/start': { summary: 'Start an experiment', tag: 'experiments' },
  'POST /experiments/{id}/stop': { summary: 'Stop an experiment', tag: 'experiments' },
  'GET /experiments/sample-size': {
    summary: 'Sample size calculator',
    tag: 'experiments',
    query: c.sampleSizeQuerySchema,
  },
  'GET /experiments/{id}/results': {
    summary: 'Results: z-test / Welch t-test, CI, lift, SRM',
    tag: 'experiments',
  },
  'GET /webhooks': { summary: 'List webhooks', tag: 'webhooks' },
  'POST /webhooks': {
    summary: 'Create a webhook (Slack-compatible payload)',
    tag: 'webhooks',
    body: c.createWebhookSchema,
  },
  'PATCH /webhooks/{id}': { summary: 'Update a webhook', tag: 'webhooks', body: c.updateWebhookSchema },
  'DELETE /webhooks/{id}': { summary: 'Delete a webhook', tag: 'webhooks' },
  'POST /webhooks/{id}/test': { summary: 'Send a test delivery', tag: 'webhooks' },
  'GET /webhooks/{id}/deliveries': { summary: 'Recent deliveries', tag: 'webhooks' },
  'GET /projects/{p}/stream': { summary: 'SSE stream of changes for the dashboard', tag: 'realtime' },
};

export interface RegisteredRoute {
  method: string;
  path: string;
}

export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function jsonSchema(schema: ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return { type: 'object' };
  }
}

export function buildOpenApi(routes: RegisteredRoute[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const path = toOpenApiPath(route.path);
    const doc = routeDocs[`${route.method} ${path}`];
    const params = Array.from(path.matchAll(/\{([^}]+)\}/g)).map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    const operation: Record<string, unknown> = {
      summary: doc?.summary ?? `${route.method} ${path}`,
      tags: [doc?.tag ?? 'other'],
      parameters: params,
      responses: {
        '200': { description: 'OK' },
        '400': { description: 'Validation error' },
        '401': { description: 'Unauthorized' },
      },
    };
    if (!doc?.public) operation.security = [{ bearer: [] }];
    if (doc?.body)
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: jsonSchema(doc.body) } },
      };
    if (path.endsWith('/envs/{env}') && route.method === 'PATCH') {
      (operation.parameters as unknown[]).push({
        name: 'If-Match',
        in: 'header',
        required: false,
        schema: { type: 'string' },
      });
      (operation.responses as Record<string, unknown>)['409'] = { description: 'Version conflict' };
    }
    paths[path] = { ...(paths[path] ?? {}), [route.method.toLowerCase()]: operation };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Feature Flags Platform API',
      version: '0.1.0',
      description: 'Management API: flags, environments, segments, approvals, experiments.',
    },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
}

export const SWAGGER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Feature Flags API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div><script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: './openapi.json', dom_id: '#ui' });</script></body></html>`;
