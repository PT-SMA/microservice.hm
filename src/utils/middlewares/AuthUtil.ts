import { BaseUtil } from "classes/bases";
import { AuthError } from "errors";
import { isNonNullish } from "helpers";
import { UtilType } from "types";

export class AuthUtil extends BaseUtil {
  override type: UtilType = "middleware";

  constructor() {
    super();

    this.checkApiKey = this.checkApiKey.bind(this);
  }

  /** Resolves the enrolled app's name from the `api-key:{key}` cache. */
  async checkApiKey(key: string): Promise<string> {
    const enrolledApp = await this.redisClient.get(`api-key:${key}`);

    if (!isNonNullish(enrolledApp)) {
      throw new AuthError("Invalid API key.");
    }

    return enrolledApp;
  }
}
