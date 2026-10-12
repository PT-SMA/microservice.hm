import { MainApp } from "app";
import { PORT } from "consts";
import { GlobalErrorHandler } from "handlers";

if (import.meta.main) {
  try {
    const app = new MainApp();
    await app.init();
    Deno.serve({ port: PORT }, app.handler);
  } catch (err) {
    const errHandler = new GlobalErrorHandler();
    errHandler.handle(err);
    Deno.exit(1);
  }
}
