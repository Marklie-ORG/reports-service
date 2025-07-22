import {
  ActivityLog,
  ClientFacebookAdAccount,
  Database,
  GCSWrapper,
  Log,
  OrganizationClient,
  PubSubWrapper,
  Report,
  SchedulingOption,
} from "marklie-ts-core";
import puppeteer from "puppeteer";
import type {
  ReportJobData,
  ReportScheduleRequest,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import { AxiosError } from "axios";
import { FacebookDataUtil } from "./FacebookDataUtil.js";
import { Temporal } from "@js-temporal/polyfill";
import { ReportsConfigService } from "../config/config.js";

const logger: Log = Log.getInstance().extend("reports-util");
const database = await Database.getInstance();
const config = ReportsConfigService.getInstance();

export class ReportsUtil {
  public static async processScheduledReportJob(
    data: ReportJobData,
  ): Promise<{ success: boolean }> {
    try {
      logger.info(`Generating report for Client UUID: ${data.clientUuid}`);

      const client = await this.getClient(data.clientUuid);
      if (!client) return { success: false };

      const adAccountReports = await this.generateAdAccountReports(
        data,
        client.uuid,
      );

      const report = await this.saveReportEntity(
        data,
        client,
        adAccountReports,
      );
      await this.updateLastRun(data.scheduleUuid);

      if (!data.reviewRequired) {
        report.gcsUrl = await this.generateAndUploadPdf(
          report.uuid,
          client.uuid,
          data.datePreset,
        );
        await database.em.flush();
      }

      await this.publishReportNotification(data, client, report);
      await this.logReportGeneration(client, report.uuid);

      return { success: true };
    } catch (e) {
      this.handleProcessingError(e);
      return { success: false };
    }
  }

  private static async getClient(
    clientUuid: string,
  ): Promise<OrganizationClient | null> {
    const client = await database.em.findOne(
      OrganizationClient,
      { uuid: clientUuid },
      { populate: ["organization"] },
    );

    if (!client) {
      logger.error(`Client with UUID ${clientUuid} not found.`);
    }

    return client;
  }

  private static async generateAdAccountReports(
    data: ReportJobData,
    clientUuid: string,
  ): Promise<any[]> {
    const adAccounts = await database.em.find(ClientFacebookAdAccount, {
      client: clientUuid,
    });

    const reportPromises = adAccounts.map(
      (adAccount: ClientFacebookAdAccount) =>
        FacebookDataUtil.getAllReportData(
          data.organizationUuid,
          adAccount.adAccountId,
          data.datePreset,
          data.metrics,
        ).then((reportData) => ({
          adAccountId: adAccount.adAccountId,
          ...reportData,
        })),
    );

    const adAccountReports = await Promise.all(reportPromises);

    logger.info("Fetched all report data.");
    return adAccountReports;
  }

  private static async saveReportEntity(
    data: ReportJobData,
    client: OrganizationClient,
    adAccountReports: any[],
  ): Promise<Report> {
    const report = database.em.create(Report, {
      organization: client.organization,
      client: client,
      reportType: "facebook",
      reviewRequired: data.reviewRequired,
      gcsUrl: "",
      schedulingOption: data.scheduleUuid,
      data: adAccountReports,
      metadata: {
        timeZone: data.timeZone,
        datePreset: data.datePreset,
        metricsSelections: data.metrics,
        loomLink: "",
        aiGeneratedContent: "",
        userReportDescription: "",
        messages: data.messages,
        images: data.images,
        // reportName: data.re,
      },
    });

    await database.em.persistAndFlush(report);
    return report;
  }

  private static async generateAndUploadPdf(
    reportUuid: string,
    clientUuid: string,
    datePreset: string,
  ): Promise<string> {
    logger.info("Generating PDF.");

    const pdfBuffer = await this.generateReportPdf(reportUuid);
    const filePath = this.generateFilePath(clientUuid, datePreset);
    const gcs = GCSWrapper.getInstance(config.get("GCS_REPORTS_BUCKET"));

    return await gcs.uploadBuffer(
      pdfBuffer,
      filePath,
      "application/pdf",
      false,
      false,
    );
  }

  private static async publishReportNotification(
    data: ReportJobData,
    client: OrganizationClient,
    report: Report,
  ): Promise<void> {
    const topic = data.reviewRequired
      ? "notification-report-ready"
      : "notification-send-report";

    const payload = {
      reportUrl: data.reviewRequired ? "" : report.gcsUrl,
      clientUuid: client.uuid,
      organizationUuid: client.organization.uuid,
      reportUuid: report.uuid,
      messages: data.messages,
    };

    logger.info("Publishing report notification.");
    await PubSubWrapper.publishMessage(topic, payload);
  }

  private static async logReportGeneration(
    client: OrganizationClient,
    reportUuid: string,
  ): Promise<void> {
    const log = database.em.create(ActivityLog, {
      organization: client.organization.uuid,
      action: "report_generated",
      targetType: "report",
      targetUuid: reportUuid,
      client: client.uuid,
      metadata: { frequency: "" },
      actor: "system",
    });

    await database.em.persistAndFlush(log);
  }

  private static handleProcessingError(error: unknown): void {
    if (error instanceof AxiosError && error.response) {
      console.error(error.response.data);
    } else {
      console.error("Failed to process scheduled report job:", error);
    }
  }

  public static async generateReportPdf(reportUuid: string): Promise<Buffer> {
    const isProduction = process.env.ENVIRONMENT === "production";
    const baseUrl = isProduction
      ? "https://marklie.com"
      : "http://localhost:4200";

    const browser = await puppeteer.launch(config.getPuppeteerConfig());

    try {
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/pdf-report/${reportUuid}`, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });

      await page.waitForSelector(".graph-card", { timeout: 60000 });

      const dashboardHeight = await page.evaluate(() => {
        const el = document.querySelector(".report-container");
        return el ? el.scrollHeight : 2000;
      });

      const pdf = await page.pdf({
        printBackground: true,
        width: "1600px",
        height: `${dashboardHeight}px`,
        pageRanges: "1",
      });

      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private static async updateLastRun(scheduleUuid: string) {
    const option = await database.em.findOne(SchedulingOption, {
      uuid: scheduleUuid,
    });

    if (option) {
      option.lastRun = new Date();
      await database.em.flush();
    }
  }

  public static generateFilePath(clientUuid: string, preset: string) {
    const today = new Date().toISOString().split("T")[0];
    return `report/${clientUuid}-facebook-report-${preset}-${today}.pdf`;
  }

  private static getWeekday(day: string) {
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

  public static getNextRunDate(
    scheduleOption: ReportScheduleRequest,
  ): Temporal.ZonedDateTime {
    const timeZone = scheduleOption.timeZone || "UTC";
    const now = Temporal.Now.zonedDateTimeISO(timeZone);

    let nextRun: Temporal.ZonedDateTime;

    const [hour, minute] = scheduleOption.time.split(":").map(Number);

    switch (scheduleOption.frequency) {
      case "weekly": {
        const targetWeekday = this.getWeekday(scheduleOption.dayOfWeek); // 1 = Monday, 7 = Sunday

        nextRun = now.with({ hour, minute, second: 0, millisecond: 0 });

        const daysUntilTarget = (targetWeekday + 7 - now.dayOfWeek) % 7 || 7;

        nextRun = nextRun.add({ days: daysUntilTarget });

        break;
      }

      case "biweekly": {
        const targetWeekday = this.getWeekday(scheduleOption.dayOfWeek);

        nextRun = now.with({ hour, minute, second: 0, millisecond: 0 });
        const daysUntilTarget = (targetWeekday + 7 - now.dayOfWeek) % 7 || 7;

        nextRun = nextRun.add({ days: daysUntilTarget });

        if (nextRun <= now) {
          nextRun = nextRun.add({ days: 14 });
        }

        break;
      }

      case "monthly": {
        const day = scheduleOption.dayOfMonth;
        const proposed = now.with({
          day,
          hour,
          minute,
          second: 0,
          millisecond: 0,
        });

        nextRun = proposed < now ? proposed.add({ months: 1 }) : proposed;

        break;
      }

      case "custom": {
        const interval = scheduleOption.intervalDays ?? 1;
        const custom = now.with({ hour, minute, second: 0, millisecond: 0 });

        nextRun =
          custom <= now
            ? now.add({ days: interval })
            : custom.add({ days: interval });

        break;
      }

      default:
        nextRun = now;
    }

    return nextRun;
  }
}
