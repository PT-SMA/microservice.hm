/**
 * Util is a reusable logic class used by routes, middlewares or other utils.
 * Routes call utils directly — there are no controllers.
 */

import { redisClient } from "modules";
import { createModels } from "models";
import { UtilType } from "types";

export abstract class BaseUtil {
  abstract type: UtilType;
  protected redisClient = redisClient;
  protected models = createModels();
}
