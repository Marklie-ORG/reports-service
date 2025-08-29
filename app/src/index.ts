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
  FACEBOOK_DATE_PRESETS,
  Log,
  SentryMiddleware,
} from "marklie-ts-core";

import { ReportQueueService } from "./lib/services/ReportsQueueService.js";
import { ReportsController } from "./lib/controllers/ReportsController.js";
import { ReportsConfigService } from "./lib/config/config.js";
import { SchedulesController } from "./lib/controllers/SchedulesController.js";
import type { ReportScheduleRequest } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces";
import type { ReportJobData } from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
// import type { ReportScheduleRequest } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

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
    /^\/api\/reports\/[^/]+$/,
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


// const request: ReportScheduleRequest = {
//   time: "13:03",
//   images: {
//     clientLogo: "",
//     organizationLogo: "",
//   },
//   messages: {
//     email: {
//       body: "3",
//       title: "2",
//     },
//     slack: "",
//     whatsapp: "1",
//   },
//   timeZone: "Europe/Kiev",
//   dayOfWeek: "Friday",
//   frequency: "weekly",
//   providers: [
//     {
//       provider: "facebook",
//       sections: [
//         {
//           name: "kpis",
//           order: 0,
//           adAccounts: [
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "spend",
//                   order: 11,
//                 },
//               ],
//               adAccountId: "act_184132280559902",
//               adAccountName: "Welvaere | Belgium",
//               customMetrics: [
//                 {
//                   id: "1811736552611626",
//                   name: "Engaged traffic",
//                   order: 8,
//                 },
//               ],
//             },
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "spend",
//                   order: 11,
//                 },
//               ],
//               adAccountId: "act_944264010376239",
//               adAccountName: "Welvaere | Europe",
//               customMetrics: [
//                 {
//                   id: "462417059508939",
//                   name: "EU | Quote Request",
//                   order: 1,
//                 },
//               ],
//             },
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "spend",
//                   order: 11,
//                 },
//               ],
//               adAccountId: "act_571336068315404",
//               adAccountName: "Welvaere | France",
//               customMetrics: [
//                 {
//                   id: "703397075058069",
//                   name: "Engaged traffic",
//                   order: 2,
//                 },
//               ],
//             },
//           ],
//         },
//         {
//           name: "graphs",
//           order: 1,
//           adAccounts: [
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "impressions",
//                   order: 0,
//                 },
//               ],
//               adAccountId: "act_944264010376239",
//               adAccountName: "Welvaere | Europe",
//               customMetrics: [
//                 {
//                   id: "462417059508939",
//                   name: "EU | Quote Request",
//                   order: 1,
//                 },
//               ],
//             },
//           ],
//         },
//         {
//           name: "ads",
//           order: 2,
//           adAccounts: [
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "ad_name",
//                   order: 9,
//                 },
//                 {
//                   name: "impressions",
//                   order: 0,
//                 },
//               ],
//               adAccountId: "act_944264010376239",
//               adAccountName: "Welvaere | Belgium",
//               customMetrics: [
//                 {
//                   id: "1811736552611626",
//                   name: "Engaged traffic",
//                   order: 8,
//                 },
//               ],
//             },
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "ad_name",
//                   order: 9,
//                 },
//                 {
//                   name: "impressions",
//                   order: 0,
//                 },
//               ],
//               adAccountId: "act_944264010376239",
//               adAccountName: "Welvaere | Europe",
//               customMetrics: [
//                 {
//                   id: "462417059508939",
//                   name: "EU | Quote Request",
//                   order: 1,
//                 },
//               ],
//             },
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "ad_name",
//                   order: 9,
//                 },
//                 {
//                   name: "impressions",
//                   order: 0,
//                 },
//               ],
//               adAccountId: "act_944264010376239",
//               adAccountName: "Welvaere | France",
//               customMetrics: [
//                 {
//                   id: "703397075058069",
//                   name: "Engaged traffic",
//                   order: 2,
//                 },
//               ],
//             },
//           ],
//         },
//         {
//           name: "campaigns",
//           order: 3,
//           adAccounts: [
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "add_to_cart",
//                   order: 11,
//                 },
//               ],
//               adAccountId: "act_184132280559902",
//               adAccountName: "Welvaere | Belgium",
//               customMetrics: [
//                 {
//                   id: "1811736552611626",
//                   name: "Engaged traffic",
//                   order: 8,
//                 },
//               ],
//             },
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "add_to_cart",
//                   order: 11,
//                 },
//               ],
//               adAccountId: "act_944264010376239",
//               adAccountName: "Welvaere | Europe",
//               customMetrics: [
//                 {
//                   id: "462417059508939",
//                   name: "EU | Quote Request",
//                   order: 1,
//                 },
//               ],
//             },
//             {
//               order: 0,
//               metrics: [
//                 {
//                   name: "add_to_cart",
//                   order: 11,
//                 },
//               ],
//               adAccountId: "act_571336068315404",
//               adAccountName: "Welvaere | France",
//               customMetrics: [
//                 {
//                   id: "703397075058069",
//                   name: "Engaged traffic",
//                   order: 2,
//                 },
//               ],
//             },
//           ],
//         },
//       ],
//     },
//   ],
//   clientUuid: "c5b300eb-ab4d-4db6-bae7-c81610dd9f5a",
//   datePreset: FACEBOOK_DATE_PRESETS.LAST_7D,
//   reportName: "Report Title",
//   reviewRequired: false,
//   organizationUuid: "2bc96d98-654e-41b0-a13f-22ed452d9f47",
// };
// const { providers, ...rest } = request;
// const jobData: ReportJobData = {
//   ...rest,
//   data: providers!,
//   scheduleUuid: "6a0262b7-457d-452c-8f3a-cc7c235dda5c",
// };
// await reportQueue.deleteAllScheduledJobs();

// // const service = new SchedulesService();
// // await service.scheduleReport(request);

// // console.log(jobData.data[0].adAccounts[0].kpis);
// // console.log(jobData.data[0].adAccounts[0].graphs);
// // console.log(jobData.data[0].adAccounts[0].ads);
// // console.log(jobData.data[0].adAccounts[0].campaigns);
// await ReportsUtil.processScheduledReportJob(jobData);

