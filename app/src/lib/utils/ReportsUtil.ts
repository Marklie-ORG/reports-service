import { DateTime, type WeekdayNumbers } from "luxon";
import {
  Database,
  GCSWrapper,
  Log,
  OrganizationClient,
  SchedulingOption,
  Report,
  ClientFacebookAdAccount,
  PubSubWrapper,
  ActivityLog,
} from "marklie-ts-core";
import puppeteer from "puppeteer";
import type {
  ReportJobData,
  ReportScheduleRequest,
  SchedulingOptionMetrics,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import {AxiosError} from "axios";
import {FacebookDataUtil} from "./FacebookDataUtil.js";

const logger: Log = Log.getInstance().extend("reports-util");
const database = await Database.getInstance();

export class ReportsUtil {
  public static async processScheduledReportJob(data: ReportJobData) {
    try {
      logger.info(`Generating report for Client UUID: ${data.clientUuid}`);

      const client = await database.em.findOne(
          OrganizationClient,
          {uuid: data.clientUuid},
          {
            populate: ["organization"],
          },
      );

      if (!client) {
        logger.error(`Client with UUID ${data.clientUuid} not found.`);
        return {success: false};
      }

      const adAccounts: ClientFacebookAdAccount = await database.em.find(ClientFacebookAdAccount, {
        client: data.clientUuid
      });

      const adAccountReports = []

      for (const adAccount of adAccounts) {
        const reportData = await FacebookDataUtil.getAllReportData(
            data.organizationUuid,
            adAccount.adAccountId,
            data.datePreset,
            data.metrics
        );
        adAccountReports.push({
          adAccountId: adAccount.adAccountId,
          ...reportData,
        });
      }

      logger.info("Fetched all report Data.")

      const report = database.em.create(Report, {
        organization: client.organization,
        client: client,
        reportType: 'facebook',
        gcsUrl: "",
        data: adAccountReports,
        metadata: {
          datePreset: data.datePreset,
          reviewNeeded: data.reviewNeeded,
          metricsSelections: data.metrics,
          loomLink: "",
          aiGeneratedContent: "",
          userReportDescription: "",
          messages: data.messages
        },
      });

      database.em.persist(report);
      await database.em.flush();

      await this.updateLastRun(client.uuid);

      logger.info("Generating PDF.")

      let publicPdfUrl = "";

      if (!data.reviewNeeded) {
        const pdfBuffer = await this.generateReportPdf(report.uuid);

        const filePath = this.generateFilePath(client.uuid, data.datePreset);
        const gcs = GCSWrapper.getInstance('marklie-client-reports');

        publicPdfUrl = await gcs.uploadBuffer(
            pdfBuffer,
            filePath,
            'application/pdf',
            false,
            false
        );

        report.gcsUrl = publicPdfUrl;
        await database.em.flush();
      }

      const payload = {
        reportUrl: data.reviewNeeded ? "" : publicPdfUrl,
        clientUuid: client.uuid,
        organizationUuid: client.organization.uuid,
        reportUuid: report.uuid,
        messages: data.messages
      };

      const topic = data.reviewNeeded
          ? "notification-report-ready"
          : "notification-send-report";

      logger.info("Sending to notification.")

      await PubSubWrapper.publishMessage(topic, payload);

      const log = database.em.create(ActivityLog, {
        organization: client.organization.uuid,
        action: 'report_generated',
        targetType: 'report',
        targetUuid: report.uuid,
        client: client.uuid,
        metadata: {
          frequency: ""
        },
        actor: 'system'
      });

      await database.em.persistAndFlush(log);

      return { success: true };
    } catch (e) {
      if (e && e instanceof AxiosError){
        console.error(e.response!.data);
      }else {
        console.error("Failed to process scheduled report job:", e);
      }
      return { success: false };
    }
  }

  private static async generateReportPdf(reportUuid: string): Promise<Buffer> {
    const isProduction = process.env.ENVIRONMENT === "production";
    const baseUrl =
        isProduction
            ? "https://marklie.com"
            : "http://localhost:4200";

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/pdf-report/${reportUuid}`, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      });

      await page.emulateMediaType('print');
      await new Promise(resolve => setTimeout(resolve, 2000));
      const pdf = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        timeout: 120000,
      });

      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  //todo:fix
  private static async updateLastRun(clientUuid: string) {
    const option = await database.em.findOne(SchedulingOption, {
      client: clientUuid,
    });

    if (option) {
      option.lastRun = new Date();
      await database.em.flush();
    }
  }

  private static generateFilePath(clientUuid: string, preset: string) {
    const today = new Date().toISOString().split("T")[0];
    return `report/${clientUuid}-facebook-report-${preset}-${today}.pdf`;
  }

  private static getWeekday(day: string): WeekdayNumbers {
    switch (day) {
      case "Monday":
        return 1;
      case "Tuesday":
        return 2;
      case "Wednesday":
        return 3;
      case "Thursday":
        return 4;
      case "Friday":
        return 5;
      case "Saturday":
        return 6;
      case "Sunday":
        return 7;
      default:
        return 1;
    }
  }

  public static getNextRunDate(scheduleOption: ReportScheduleRequest) {
    const tz = scheduleOption.timeZone || "UTC";
    const now = DateTime.now().setZone(tz);
    let nextRun: DateTime;

    switch (scheduleOption.frequency) {
      case "weekly": {
        const targetWeekday: WeekdayNumbers = this.getWeekday(
            scheduleOption.dayOfWeek,
        );
        const [hour, minute] = scheduleOption.time.split(":").map(Number);
        nextRun = now.set({
          weekday: targetWeekday,
          hour: hour,
          minute: minute,
          second: 0,
          millisecond: 0,
        });
        if (nextRun < now) {
          nextRun = nextRun.plus({weeks: 1});
        }
        break;
      }
      case "biweekly": {
        const targetWeekday: WeekdayNumbers = this.getWeekday(
            scheduleOption.dayOfWeek,
        );
        const [hour, minute] = scheduleOption.time.split(":").map(Number);

        nextRun = now.set({
          weekday: targetWeekday,
          hour: hour,
          minute: minute,
          second: 0,
          millisecond: 0,
        });
        if (nextRun < now) {
          nextRun = nextRun.plus({weeks: 2});
        }
        break;
      }
      case "monthly": {
        const [hour, minute] = scheduleOption.time.split(":").map(Number);
        nextRun = now.set({
          day: scheduleOption.dayOfMonth,
          hour: hour,
          minute: minute,
          second: 0,
          millisecond: 0,
        });
        if (nextRun < now) {
          nextRun = nextRun.plus({months: 1});
        }
        break;
      }
      case "custom": {
        const [hour, minute] = scheduleOption.time.split(":").map(Number);
        nextRun = now.set({
          hour: hour,
          minute: minute,
          second: 0,
          millisecond: 0,
        });
        if (nextRun < now) {
          nextRun = now.plus({days: scheduleOption.intervalDays});
        } else {
          nextRun = nextRun.plus({
            days: scheduleOption.intervalDays,
          });
        }
        break;
      }
      default: {
        nextRun = now;
      }
    }
    return nextRun;
  }
}