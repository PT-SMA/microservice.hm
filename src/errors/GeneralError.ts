import { ContentfulStatusCode } from "hono/utils/http-status";
import { BaseError } from "./BaseError.ts";

export class GeneralError extends BaseError {
  override statusCode: ContentfulStatusCode = 500;
  constructor(msg: string, name?: string) {
    super(msg, name);
  }
}
