import { ContentfulStatusCode } from "hono/utils/http-status";
import { BaseError } from "./BaseError.ts";

export class AuthError extends BaseError {
  override statusCode: ContentfulStatusCode;
  constructor(msg: string, name?: string) {
    super(msg, name);

    this.statusCode = 401;
  }
}
