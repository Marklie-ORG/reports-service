import Koa from "koa";
import koabodyparser from "koa-bodyparser";
import cors from "@koa/cors";
import "dotenv/config";
import {
  ActivityLogMiddleware,
  AuthMiddleware,
  CookiesMiddleware,
  Database,
  ErrorMiddleware,
  Log,
  SentryMiddleware,
  ValidationMiddleware,
} from "marklie-ts-core";

import { ReportQueueService } from "./lib/services/ReportsQueueService.js";
import { ReportsController } from "./lib/controllers/ReportsController.js";
import { ReportsConfigService } from "./lib/config/config.js";
import { SchedulesController } from "./lib/controllers/SchedulesController.js";

const app = new Koa();
const logger = Log.getInstance();
const config = ReportsConfigService.getInstance();

const database = await Database.getInstance();
logger.info("Database connected!");

const reportQueue = ReportQueueService.getInstance();

app.use(
  cors({
    origin: (ctx) => {
      const allowedOrigins = config.get("ALLOWED_ORIGINS");
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
app.use(
  AuthMiddleware([
    "/api/scheduling-options/available-metrics",
  ]),
);
app.use(ValidationMiddleware());
app.use(ErrorMiddleware());
app.use(SentryMiddleware());
app.use(ActivityLogMiddleware());

app.use(new ReportsController().routes());
app.use(new ReportsController().allowedMethods());

app.use(new SchedulesController().routes());
app.use(new SchedulesController().allowedMethods());

const PORT = config.get("PORT");
app.listen(PORT, () => {
  logger.info(`Reports service running on port ${PORT}`);
});
process.on("SIGINT", async () => {
  logger.error("🛑 Gracefully shutting down...");
  await reportQueue.close();
  await database.orm.close();
  process.exit(0);
});

