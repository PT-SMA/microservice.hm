import { ContentfulStatusCode } from "hono/utils/http-status";
import { isNonNullish } from "helpers";

export abstract class BaseError extends Error {
  constructor(msg: string, name?: string) {
    super(msg);
    this.message = msg;
    if (isNonNullish(name)) this.name = name;
  }

  abstract statusCode: ContentfulStatusCode;
}
