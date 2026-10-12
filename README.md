# Deno Backend Template

This repository will be a template for creating backend for future projects.

## Before running

Before you run the project, you would likely need to run this command:
`deno install`

## Available resources

- File based routing (subrouting included). Route files call utils directly —
  there are no controllers.
- `utils` — reusable logic classes extending `BaseUtil` (`this.redisClient`,
  `this.models`), grouped by `routes`, `middlewares` and `others`.
- `middlewares` — Hono middlewares (`createMiddleware`) that delegate to a util
  and set context variables.
- `modules` — specific-case infrastructure (Redis client, event emitter).
- `helpers` — small, pure functions only.
- `handlers` — event-related code (socket.io, pub/sub, error handling) extending
  `BaseHandler`.
- Models — memoized `createModels()` (Sequelize + pg), one pool per process.

## Development

`deno task dev`
