# ADR 0011: NestJS with explicit injection tokens and zod validation

- Status: accepted
- Date: 2026-10-01

## Context

The API is NestJS. The usual setup relies on `emitDecoratorMetadata` and `class-validator` DTOs. esbuild-based tooling (tsx, tsup, Vitest) does not emit decorator metadata, and the request schemas already exist as zod schemas in the shared contracts package.

## Decision

Every constructor dependency uses `@Inject(Token)`; request bodies and queries are validated with a `ZodPipe` built from the contracts schemas. The API is bundled with tsup. OpenAPI is generated at runtime from the registered Express routes plus a route table that attaches zod schemas (converted with `z.toJSONSchema`), and a test fails if any route is undocumented.

## Consequences

- One source of truth for validation shared with the dashboard; no duplicated DTO classes.
- Fast builds and tests (esbuild) without `reflect-metadata` emit; slightly more verbose constructors.
- `@nestjs/swagger` decorators are not used; the generated document is less detailed about response shapes than a fully annotated Swagger setup.
