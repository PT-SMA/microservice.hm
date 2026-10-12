import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { BaseError } from "errors";
import { BaseHandler } from "classes/bases";
import { HandlerType } from "types";

export class AppErrorHandler extends BaseHandler {
  override type: HandlerType = "error";

  constructor() {
    super();
  }

  handle404(c: Context) {
    return c.json(
      {
        errors: [
          {
            msg: `Cannot find the route of ${c.req.path}`,
          },
        ],
      },
      404,
    );
  }

  override handle(err: unknown, c: Context): Response {
    switch (true) {
      case err instanceof HTTPException: {
        return err.getResponse();
      }
      case err instanceof BaseError: {
        return c.json(
          {
            errors: [
              {
                msg: err.message,
                name: err.name,
              },
            ],
          },
          err.statusCode,
        );
      }
      case err instanceof Error: {
        return c.json(
          {
            errors: [
              {
                msg: err.message,
                name: err.name,
              },
            ],
          },
          500,
        );
      }
      // case err instanceof NotF
      default: {
        return c.json(
          {
            errors: [
              {
                msg: "Unknown error occurred",
              },
            ],
          },
          500,
        );
      }
    }
  }
}
