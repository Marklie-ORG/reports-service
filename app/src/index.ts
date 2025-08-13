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
  // FACEBOOK_DATE_PRESETS,
  Log,
  // type ReportJobData,
  ValidationMiddleware,
} from "marklie-ts-core";

import { ReportQueueService } from "./lib/services/ReportsQueueService.js";
import { ReportsController } from "./lib/controllers/ReportsController.js";
import { ReportsConfigService } from "./lib/config/config.js";
import { SchedulesController } from "./lib/controllers/SchedulesController.js";
// import type { ReportScheduleRequest } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

const app = new Koa();
const logger = Log.getInstance().extend("reports-service");
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
    /^\/api\/reports\/[^/]+$/,
    "/api/scheduling-options/available-metrics",
  ]),
);
app.use(ValidationMiddleware());
app.use(ErrorMiddleware());
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

// const request: ReportScheduleRequest = {
//   frequency: "weekly",
//   time: "09:00",
//   timeZone: "America/New_York",
//   dayOfWeek: "Monday",

//   clientUuid: "c5b300eb-ab4d-4db6-bae7-c81610dd9f5a",
//   organizationUuid: "2bc96d98-654e-41b0-a13f-22ed452d9f47",
//   reportName: "Weekly Facebook Summary",
//   reviewRequired: true,
//   datePreset: FACEBOOK_DATE_PRESETS.LAST_7D, // Assuming from your FACEBOOK_DATE_PRESETS enum

//   messages: {
//     whatsapp: "Here’s your weekly ad performance!",
//     slack: "Weekly ad report is ready :bar_chart:",
//     email: {
//       title: "Weekly Facebook Report",
//       body: "Attached is your Facebook ad performance for the last 7 days.",
//     },
//   },

//   images: {
//     clientLogo: "https://cdn.example.com/logos/client.png",
//     organizationLogo: "https://cdn.example.com/logos/org.png",
//   },

//   providers: [
//     {
//       provider: "facebook",
//       adAccounts: [
//         {
//           adAccountId: "act_1083076062681667",
//           kpis: {
//             order: 1,
//             metrics: [
//               { name: "spend", order: 1 },
//               { name: "clicks", order: 2 },
//               { name: "ctr", order: 3 },
//             ],
//           },
//           graphs: {
//             order: 2,
//             metrics: [
//               { name: "impressions", order: 1 },
//               { name: "reach", order: 2 },
//             ],
//           },
//           ads: {
//             order: 3,
//             metrics: [
//               { name: "ad_name", order: 1 },
//               { name: "cpc", order: 2 },
//             ],
//           },
//           campaigns: {
//             order: 4,
//             metrics: [
//               { name: "purchases", order: 1 },
//               { name: "conversion_value", order: 2 },
//             ],
//           },
//         },
//       ],
//     },
//   ],
// };
// const { providers, ...rest } = request;
// const jobData: ReportJobData = {
//   ...rest,
//   data: providers!,
//   scheduleUuid: "6a0262b7-457d-452c-8f3a-cc7c235dda5c",
// };
// console.log(jobData.data[0].adAccounts[0].kpis);
// console.log(jobData.data[0].adAccounts[0].graphs);
// console.log(jobData.data[0].adAccounts[0].ads);
// console.log(jobData.data[0].adAccounts[0].campaigns);
// await ReportsUtil.processScheduledReportJob(jobData);
