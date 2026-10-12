/**
 * Handler is an abstraction for handling external data — here, frames from
 * the hour meter — or errors.
 */

import { HandlerType } from "types";

export abstract class BaseHandler {
  abstract type: HandlerType;

  constructor() {
    this.handle = this.handle.bind(this);
  }

  abstract handle(...args: unknown[]): void | unknown;
}
