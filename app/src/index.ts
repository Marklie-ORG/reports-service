import Koa from "koa";
import "dotenv/config";
import { Database, Log, Validator } from "marklie-ts-core";

import { ReportQueueService } from "./lib/services/ReportsQueueService.js";
import { ReportsConfigService } from "./lib/config/config.js";
import { reportsValidationRules } from "./lib/schemas/ValidationRules.js";
import { routes } from "./routes.js";
import { applyMiddlewares } from "./middlewares.js";

const app = new Koa();
const logger = Log.getInstance();
const config = ReportsConfigService.getInstance();

const database = await Database.getInstance();
logger.info("Database connected and entities loaded!");

Validator.registerRules(reportsValidationRules);
logger.info("Validation rules registered!");

const reportQueue = ReportQueueService.getInstance();

applyMiddlewares(app, config);
app.use(routes);

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
