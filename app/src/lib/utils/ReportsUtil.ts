import {
  ActivityLog,
  Database,
  FACEBOOK_DATE_PRESETS,
  GCSWrapper,
  Log,
  OrganizationClient,
  PubSubWrapper,
  Report,
  SchedulingOption,
} from "marklie-ts-core";
import puppeteer from "puppeteer";
import type {
  ReportData,
  ReportJobData,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import { AxiosError } from "axios";
import { Temporal } from "@js-temporal/polyfill";
import { ReportsConfigService } from "../config/config.js";
import type {
  ReportScheduleRequest,
  SectionConfig,
} from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";
import { ProviderFactory } from "../providers/ProviderFactory.js";
import { CronUtil } from "./CronUtil.js";

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

      const providersData = await this.generateProvidersReports(data);

      const schedulingOption = await database.em.findOne(SchedulingOption, {
        uuid: data.scheduleUuid,
      });

      if (!schedulingOption) {
        logger.warn(
          `Scheduling option ${data.scheduleUuid} not found or inactive. Skipping job.`,
        );
        return { success: false };
      }
      data.pdfFilename = this.generatePdfFilename(schedulingOption);

      const report = await this.saveReportEntity(data, client, providersData);

      await this.updateLastRun(data.scheduleUuid);
      schedulingOption.nextRun =
        CronUtil.getNextRunDateFromCron(schedulingOption);

      if (!data.reviewRequired) {
        report.storage.pdfGcsUri = await this.generateAndUploadPdf(
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

  public static getDateRangeForPreset(
    preset: FACEBOOK_DATE_PRESETS,
    baseDate?: Date,
  ): { start: Date; end: Date } {
    const today = baseDate ? new Date(baseDate) : new Date();
    const startOfDay = (d: Date) =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const addDays = (d: Date, days: number) => {
      const nd = new Date(d);
      nd.setDate(nd.getDate() + days);
      return nd;
    };

    const endYesterday = startOfDay(addDays(today, -1));

    const rangeForLastNDays = (n: number) => {
      const end = endYesterday;
      const start = addDays(end, -(n - 1));
      return { start, end };
    };

    switch (preset) {
      case FACEBOOK_DATE_PRESETS.TODAY: {
        const d = startOfDay(today);
        return { start: d, end: d };
      }
      case FACEBOOK_DATE_PRESETS.YESTERDAY: {
        const d = endYesterday;
        return { start: d, end: d };
      }
      case FACEBOOK_DATE_PRESETS.LAST_3D:
        return rangeForLastNDays(3);
      case FACEBOOK_DATE_PRESETS.LAST_7D:
        return rangeForLastNDays(7);
      case FACEBOOK_DATE_PRESETS.LAST_14D:
        return rangeForLastNDays(14);
      case FACEBOOK_DATE_PRESETS.LAST_28D:
        return rangeForLastNDays(28);
      case FACEBOOK_DATE_PRESETS.LAST_30D:
        return rangeForLastNDays(30);
      case FACEBOOK_DATE_PRESETS.LAST_90D:
        return rangeForLastNDays(90);
      case FACEBOOK_DATE_PRESETS.THIS_MONTH: {
        const start = new Date(today.getFullYear(), today.getMonth(), 1);
        const end = endYesterday;
        return { start, end };
      }
      case FACEBOOK_DATE_PRESETS.LAST_MONTH: {
        const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const end = new Date(today.getFullYear(), today.getMonth(), 0);
        return { start, end };
      }
      case FACEBOOK_DATE_PRESETS.THIS_QUARTER: {
        const quarterStartMonth = Math.floor(today.getMonth() / 3) * 3;
        const start = new Date(today.getFullYear(), quarterStartMonth, 1);
        const end = endYesterday;
        return { start, end };
      }
      case FACEBOOK_DATE_PRESETS.LAST_QUARTER: {
        const thisQuarterStartMonth = Math.floor(today.getMonth() / 3) * 3;
        const start = new Date(
          today.getFullYear(),
          thisQuarterStartMonth - 3,
          1,
        );
        const end = new Date(today.getFullYear(), thisQuarterStartMonth, 0);
        return { start, end };
      }
      case FACEBOOK_DATE_PRESETS.THIS_YEAR: {
        const start = new Date(today.getFullYear(), 0, 1);
        const end = endYesterday;
        return { start, end };
      }
      case FACEBOOK_DATE_PRESETS.LAST_YEAR: {
        const start = new Date(today.getFullYear() - 1, 0, 1);
        const end = new Date(today.getFullYear() - 1, 11, 31);
        return { start, end };
      }
      case FACEBOOK_DATE_PRESETS.MAXIMUM:
      default: {
        return rangeForLastNDays(7);
      }
    }
  }

  private static formatDateShort(d: Date): string {
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}.${mm}.${yy}`;
  }

  public static getDateRangeTextForPreset(
    preset: FACEBOOK_DATE_PRESETS,
    baseDate?: Date,
  ): string {
    const { start, end } = this.getDateRangeForPreset(preset, baseDate);
    return `${this.formatDateShort(start)} - ${this.formatDateShort(end)}`;
  }

  private static generatePdfFilename(
    schedulingOption: SchedulingOption,
  ): string {
    if (!schedulingOption?.nextRun) {
      return "Report";
    }
    const date = new Date(schedulingOption.nextRun);
    const day = String(date.getUTCDate()).padStart(2, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const year = String(date.getUTCFullYear()).slice(-2);
    const formatted = `${day}.${month}.${year}`;

    console.log(schedulingOption);

    const dateRangeText = this.getDateRangeTextForPreset(
      schedulingOption.datePreset,
      schedulingOption.nextRun,
    );

    return (
      formatted +
      " " +
      schedulingOption.client.name +
      " (" +
      dateRangeText +
      ")"
    );
  }

  private static async generateProvidersReports(
    data: ReportJobData,
  ): Promise<ReportData[]> {
    const providersData: ReportData[] = [];

    for (const providerConfig of data.data) {
      try {
        const provider = ProviderFactory.create(
          providerConfig.provider,
          data.organizationUuid,
        );
        await provider.authenticate(data.organizationUuid);

        const sections = await provider.getProviderData(
          providerConfig.sections as unknown as SectionConfig[],
          data.clientUuid,
          data.organizationUuid,
          data.datePreset,
        );

        providersData.push({
          provider: providerConfig.provider,
          sections,
        });
      } catch (error) {
        logger.error(
          `Error processing ${providerConfig.provider} data:`,
          error,
        );
        console.log(error);
      }
    }

    return providersData;
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

  private static async saveReportEntity(
    data: ReportJobData,
    client: OrganizationClient,
    generatedReportData: Record<string, any>,
  ): Promise<Report> {
    const title = data.reportName?.trim() || "Report";
    const pdfFilename =
      data.pdfFilename?.trim() ||
      `${new Date().toISOString().slice(0, 10)} ${client.name}`;

    const report = database.em.create(Report, {
      organization: client.organization,
      client,
      type: "facebook",
      schedulingOption: data.scheduleUuid,
      review: {
        required: data.reviewRequired,
        reviewedAt: null,
      },
      storage: {
        pdfGcsUri: "",
      },
      schedule: {
        timezone: data.timeZone,
        lastRun: undefined,
        nextRun: undefined,
        jobId: undefined,
        datePreset: data.datePreset,
      },
      customization: {
        title,
        colors: {
          headerBg: data.colors?.headerBackgroundColor ?? "#ffffff",
          reportBg: data.colors?.reportBackgroundColor ?? "#ffffff",
        },
        logos: {
          org: { gcsUri: data.images?.organizationLogo ?? "" },
          client: { gcsUri: data.images?.clientLogo ?? "" },
        },
      },
      messaging: {
        email: {
          title: data.messages?.email?.title ?? "",
          body: data.messages?.email?.body ?? "",
        },
        slack: data.messages?.slack ?? "",
        whatsapp: data.messages?.whatsapp ?? "",
        pdfFilename,
      },

      data: generatedReportData,
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
    const topic = report.review.required
      ? "notification-report-ready"
      : "notification-send-report";

    const payload = {
      reportUrl: data.reviewRequired ? "" : report.storage.pdfGcsUri,
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
      logger.error(error.response.data);
    } else {
      logger.error("Failed to process scheduled report job:", error);
      console.error(error);
    }
  }

  public static async generateReportPdf(reportUuid: string): Promise<Buffer> {
    let baseUrl: string;
    switch (process.env.ENVIRONMENT) {
      case "production":
        baseUrl = "https://marklie.com";
        break;
      case "staging":
        baseUrl = "https://staging.marklie.com";
        break;
      default:
        baseUrl = "http://localhost:4200";
    }

    const browser = await puppeteer.launch(config.getPuppeteerConfig());

    try {
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/pdf-report/${reportUuid}`, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
      await new Promise((res) => setTimeout(res, 3000));

      const dashboardHeight = await page.evaluate(() => {
        const el = document.querySelector(
          ".report-container",
        ) as HTMLElement | null;
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
    schedule: ReportScheduleRequest,
  ): Temporal.ZonedDateTime {
    const timeZone = schedule.timeZone || "UTC";
    const now = Temporal.Now.zonedDateTimeISO(timeZone);
    const [hour, minute] = schedule.time.split(":").map(Number);

    const baseTimeToday = now.with({ hour, minute, second: 0, millisecond: 0 });

    switch (schedule.frequency) {
      case "weekly":
      case "biweekly": {
        const targetWeekday = this.getWeekday(schedule.dayOfWeek);
        const todayWeekday = now.dayOfWeek;

        let daysUntil: number;
        if (targetWeekday > todayWeekday) {
          daysUntil = targetWeekday - todayWeekday;
        } else if (targetWeekday < todayWeekday) {
          daysUntil = 7 - (todayWeekday - targetWeekday);
        } else {
          daysUntil =
            Temporal.ZonedDateTime.compare(baseTimeToday, now) > 0 ? 0 : 7;
        }

        let next = baseTimeToday.add({ days: daysUntil });

        if (schedule.frequency === "biweekly") {
          if (Temporal.ZonedDateTime.compare(next, now) <= 0) {
            next = next.add({ days: 14 });
          }
        }

        return next;
      }

      case "monthly": {
        const day = schedule.dayOfMonth || 1;
        const proposed = baseTimeToday.with({ day });
        return Temporal.ZonedDateTime.compare(proposed, now) > 0
          ? proposed
          : proposed.add({ months: 1 });
      }

      case "custom": {
        const interval = schedule.intervalDays ?? 1;
        return Temporal.ZonedDateTime.compare(baseTimeToday, now) > 0
          ? baseTimeToday
          : baseTimeToday.add({ days: interval });
      }

      default:
        return Temporal.ZonedDateTime.compare(baseTimeToday, now) > 0
          ? baseTimeToday
          : baseTimeToday.add({ days: 1 });
    }
  }
}
