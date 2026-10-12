import { createMiddleware } from "hono/factory";
import { AuthError } from "errors";
import { isNonNullish } from "helpers";
import { ApiKey, AppEnv } from "types";
import { AuthUtil } from "utils";

export const apiKey = createMiddleware<AppEnv & ApiKey>(async (c, next) => {
  const key = c.req.header("x-api-key");

  if (!isNonNullish(key)) {
    throw new AuthError("unauthorized");
  }

  const authUtil = new AuthUtil();
  const enrolledApp = await authUtil.checkApiKey(key);

  c.set("enrolled_app", enrolledApp);

  await next();
});
