import Koa from "koa";
import koabodyparser from "koa-bodyparser";
import cors from "@koa/cors";
import "dotenv/config";

import { ReportQueueService } from "./lib/services/ReportsQueueService.js";
import { ReportsController } from "./lib/controllers/ReportsController.js";
import {
  ActivityLogMiddleware,
  AuthMiddleware,
  CookiesMiddleware,
  Database,
  ErrorMiddleware,
  Log,
  ValidationMiddleware,
} from "marklie-ts-core";

const app = new Koa();
const logger = Log.getInstance().extend("service");

const database = await Database.getInstance();

logger.info("Database has connected!");

const reportQueue = ReportQueueService.getInstance();

app.use(
  cors({
    origin: (ctx) => {
      const allowedOrigins = [
        "http://localhost:4200",
        "https://marklie.com",
        "https://ae08-77-174-130-35.ngrok-free.app",
      ];
      const requestOrigin = ctx.request.header.origin;
      if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
        return requestOrigin;
      }
      return allowedOrigins[0];
    },
    credentials: true,
  }),
);
app.use(koabodyparser());
app.use(CookiesMiddleware);
app.use(AuthMiddleware([/^\/api\/reports\/[^/]+$/]));
app.use(ValidationMiddleware());
app.use(ActivityLogMiddleware());
app.use(ErrorMiddleware());

app
  .use(new ReportsController().routes())
  .use(new ReportsController().allowedMethods());

const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  logger.info(`Auth server is running at ${PORT}`);
});
process.on("SIGINT", async () => {
  logger.error("🛑 Gracefully shutting down...");
  await reportQueue.close();
  await database.orm.close();
  process.exit(0);
});
