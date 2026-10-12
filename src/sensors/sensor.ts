export type SensorStatus = "RUNNING" | "ERROR" | "STOP";

export abstract class Sensor {
  abstract name: string;
  abstract status: SensorStatus;

  protected abstract init(): void | Promise<void>;
  protected abstract read(): void | Promise<void>;
  abstract stop(): void | Promise<void>;
}
