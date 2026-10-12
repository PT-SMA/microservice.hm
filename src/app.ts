import { Hono } from "hono";
import { Router } from "routes";
import { redisClient } from "modules";
import { createModels } from "models";
import { Server } from "socket.io";
import { cors } from "hono/cors";
import { AppErrorHandler, SocketHandler } from "handlers";
import { DB_ALTER } from "consts";

export class MainApp {
  name = "scaffolding.deno"; // <- change this with the app's name
  private app = new Hono();
  private io = new Server({
    cors: {
      origin: "*",
    },
  });
  private errorHandler = new AppErrorHandler();
  private models = createModels();

  constructor() {
    this.init = this.init.bind(this);
    this.initRoutes = this.initRoutes.bind(this);
    this.initRedis = this.initRedis.bind(this);
    this.initDB = this.initDB.bind(this);
  }

  async init() {
    await this.initRedis();
    this.initSocket();
    await this.initDB();
    await this.initRoutes();
  }

  private async initRoutes() {
    const router = new Router(this.models);
    await router.initiateRoutes();

    this.app.use(
      "/*",
      cors({
        origin: "*",
      }),
    );

    this.app.get("/", (c) => {
      return c.json({
        appName: this.name,
      });
    });

    this.app.route("/", router.apiRoute);
    this.app.onError(this.errorHandler.handle);
    this.app.notFound(this.errorHandler.handle404);
  }

  private initSocket() {
    this.io.on("connection", (socket) => {
      const handler = new SocketHandler(socket);
      handler.handle();
    });
  }

  private async initRedis() {
    redisClient.on("error", (err) => console.error("Redis error:", err));
    await redisClient.connect();
  }

  private async initDB() {
    if (DB_ALTER) {
      await this.models.sequelize.sync({ alter: true });
    } else {
      await this.models.sequelize.authenticate({ logging: false });
    }
  }

  handler = this.io.handler(async (req) => {
    return (await this.app.fetch(req)) || new Response([], { status: 404 });
  });
}
