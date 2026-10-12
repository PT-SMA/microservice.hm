/**
 * Handler is an abstraction for handling external data using WebSocket (socket.io) or custom event handler
 */

import { redisClient } from "modules";
import { createModels } from "models";
import { HandlerType } from "types";

export abstract class BaseHandler {
  abstract type: HandlerType;
  protected redisClient = redisClient;
  protected models = createModels();

  constructor() {
    this.handle = this.handle.bind(this);
  }

  abstract handle(...args: unknown[]): void | unknown;
}
