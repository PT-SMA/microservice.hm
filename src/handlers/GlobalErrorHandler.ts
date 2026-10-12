import { HTTPException } from "hono/http-exception";
import { BaseError } from "errors";
import { BaseHandler } from "classes/bases";
import { HandlerType } from "types";

export class GlobalErrorHandler extends BaseHandler {
  override type: HandlerType = "error";

  constructor() {
    super();
  }

  override handle(err: unknown): void {
    const date = new Date().toISOString();
    switch (true) {
      case err instanceof HTTPException: {
        console.log(`[${date}]: ${err.message}`);
        break;
      }
      case err instanceof BaseError: {
        console.log(`[${date}]: ${err.message}`);
        break;
      }
      case err instanceof Error: {
        // full error, not just `message` — e.g. Sequelize's
        // ConnectionRefusedError has an empty message
        console.error(`[${date}]:`, err);
        break;
      }

      // case err instanceof NotF
      default: {
        console.log(`[${date}]: Unknown error occurred`);
        break;
      }
    }
  }
}
