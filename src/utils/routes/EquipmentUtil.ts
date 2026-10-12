import { BaseUtil } from "classes/bases";
import { PostEquipmentBody, RedisEquipmentRadius, UtilType } from "types";

type GeoCoordinates = {
  latitude: number;
  longitude: number;
};

export class EquipmentUtil extends BaseUtil {
  override type: UtilType = "routes";

  constructor() {
    super();

    this.getNearby = this.getNearby.bind(this);
    this.addPosition = this.addPosition.bind(this);
  }

  /** Excavators within `radius` of `center`, with their coordinates and distance. */
  async getNearby(
    center: GeoCoordinates,
    radius: number,
    unit: "m" | "km",
  ): Promise<Array<RedisEquipmentRadius>> {
    return await this.redisClient.geoRadiusWith(
      "Excavator",
      center,
      radius,
      unit,
      ["WITHCOORD", "WITHDIST"],
    );
  }

  /** Stores the equipment's position in the geo set named after its type. */
  async addPosition(body: PostEquipmentBody): Promise<number> {
    return await this.redisClient.geoAdd(body.type, {
      latitude: body.latitude,
      longitude: body.longitude,
      member: body.hull_number,
    });
  }
}
