import { MainApp } from "app";
import { PORT } from "consts";
import { GlobalErrorHandler } from "handlers";

if (import.meta.main) {
  try {
    const app = new MainApp();
    Deno.serve({ port: PORT }, app.fetch);

    // release the serial port on `docker stop`, so the next start can open it
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      Deno.addSignalListener(signal, async () => {
        console.log(`${signal}: closing the device link`);
        await app.stop();
        Deno.exit(0);
      });
    }
  } catch (err) {
    const errHandler = new GlobalErrorHandler();
    errHandler.handle(err);
    Deno.exit(1);
  }
}
