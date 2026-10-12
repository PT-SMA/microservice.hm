import { ContentfulStatusCode } from "hono/utils/http-status";
import { BaseError } from "./BaseError.ts";

export class NotFoundError extends BaseError {
  constructor(msg: string, name?: string) {
    super(msg, name);
  }

  override statusCode: ContentfulStatusCode = 404;
}
