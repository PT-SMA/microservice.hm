import { Hono } from "hono";
import { apiKey } from "middlewares";
import { AppEnv, PostEquipmentBody, TModelInstances } from "types";
import { EquipmentUtil } from "utils";
import { isNonNullish } from "helpers";

export default function createEquipmentRoute(_models: TModelInstances) {
  const equipmentRoute = new Hono<AppEnv>();
  const equipmentUtil = new EquipmentUtil();

  equipmentRoute.get("/", async (c) => {
    const excas = await equipmentUtil.getNearby(
      {
        longitude: 121.8117801607159,
        latitude: -3.0019732368024847,
      },
      80,
      "km",
    );

    return c.json({
      data: excas,
    });
  });

  equipmentRoute.post("/", apiKey, async (c) => {
    const body = await c.req.json<PostEquipmentBody>();

    if (isNonNullish(body.checkDist) && body.checkDist) {
      const nearby = await equipmentUtil.getNearby(
        {
          latitude: body.latitude,
          longitude: body.longitude,
        },
        10,
        "m",
      );

      return c.json({
        data: nearby,
        status: false,
      });
    }

    const added = await equipmentUtil.addPosition(body);

    return c.json({
      data: added,
      status: added === 1,
    });
  });

  return equipmentRoute;
}
