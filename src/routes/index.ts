import * as path from "@std/path";
import { isNonNullish } from "helpers";
import { Hono } from "hono";
import { RouteFactory, TModelInstances } from "types";
import { createModels } from "models";

export class Router {
  private routes: Array<string> = [];
  apiRoute = new Hono().basePath("/api");
  routers: Array<Hono> = [];
  constructor(private models: TModelInstances) {
    this.checkDir();

    this.initiateRoutes = this.initiateRoutes.bind(this);
  }

  async initiateRoutes() {
    await Promise.all(
      this.routes.map(async (route) => {
        const filePath = path.relative(
          path.resolve(Deno.cwd(), "src", "routes"),
          route,
        );
        const module: RouteFactory | undefined = await import(`./${filePath}`)
          .then((v) => v.default);

        if (typeof module === "function") {
          const filename = this.getFilename(filePath);

          try {
            this.apiRoute.route(`/${filename}`, module(this.models));
          } catch (e) {
            console.error(e, filename);
          }
        }
      }),
    );
  }

  private checkDir(dirPath?: string) {
    const routeBasePath = path.fromFileUrl(import.meta.url);
    let cwd = path.dirname(routeBasePath);
    if (isNonNullish(dirPath)) {
      cwd = path.join(path.dirname(routeBasePath), dirPath);
    }

    const files = Array.from(Deno.readDirSync(cwd)).filter(
      (file) => file.name !== "index.ts",
    );

    for (const file of files) {
      if (file.isFile) {
        const filePath = path.join(cwd, file.name);
        this.routes.push(filePath);
      } else if (!file.isFile && file.isDirectory) {
        this.checkDir(
          isNonNullish(dirPath) ? path.join(dirPath, file.name) : file.name,
        );
      }
    }
  }

  private getFilename(filePath: string) {
    const ext = path.extname(filePath);
    const fileWithoutExt = filePath.substring(0, filePath.length - ext.length);

    return fileWithoutExt;
  }
}

// debug only
if (import.meta.main) {
  new Router(createModels());
}
