/**
 * Records the travel-direction estimator's inputs and decisions as NDJSON,
 * for calibrating its thresholds on real machines
 * (`HOUR_METER_DIRECTION_RECORD=<dir>`; replay with
 * `deno run -A scripts/replay-direction.ts <files>`). One file per hour,
 * the newest 24 kept. At a 100 Hz IMU stream that is about 30 MB an hour —
 * for calibration sessions, not for every truck.
 *
 * Never throws: a full disk must not stop the reader.
 */
export class DirectionRecorder {
  #buffer: string[] = [];
  #timer: ReturnType<typeof setInterval>;
  #failed = false;
  static readonly KEEP_FILES = 24;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      Deno.mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.fail(err);
    }
    this.#timer = setInterval(() => this.flush(), 1000);
  }

  write(kind: string, data: Record<string, unknown>): void {
    if (this.#failed) return;
    this.#buffer.push(JSON.stringify({ t: this.now(), kind, ...data }));
  }

  flush(): void {
    if (this.#failed || this.#buffer.length === 0) return;
    const lines = this.#buffer.join("\n") + "\n";
    this.#buffer = [];
    const hour = new Date(this.now()).toISOString().slice(0, 13).replace(
      /[-:]/g,
      "",
    );
    try {
      Deno.writeTextFileSync(`${this.dir}/direction-${hour}.ndjson`, lines, {
        append: true,
      });
      this.prune();
    } catch (err) {
      this.fail(err);
    }
  }

  close(): void {
    clearInterval(this.#timer);
    this.flush();
  }

  private prune(): void {
    const files = [...Deno.readDirSync(this.dir)]
      .filter((e) => e.isFile && /^direction-\d{8}T\d{2}\.ndjson$/.test(e.name))
      .map((e) => e.name)
      .sort();
    for (const name of files.slice(0, -DirectionRecorder.KEEP_FILES)) {
      Deno.removeSync(`${this.dir}/${name}`);
    }
  }

  private fail(err: unknown): void {
    this.#failed = true;
    console.error(
      `travel direction: recorder stopped (${this.dir}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
