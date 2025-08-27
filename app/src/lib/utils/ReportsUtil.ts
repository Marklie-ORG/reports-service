import {
  ActivityLog,
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

const logger: Log = Log.getInstance().extend("reports-util");
const database = await Database.getInstance();
const config = ReportsConfigService.getInstance();

export class ReportsUtil {
  public static async processScheduledReportJob(
    data: ReportJobData,
  ): Promise<{ success: boolean }> {
    try {
      const isActive = await this.isSchedulingOptionActive(data.scheduleUuid);

      if (!isActive) {
        logger.info(
          `Scheduling option ${data.scheduleUuid} is not active. Skipping report generation.`,
        );
        return { success: true };
      }

      logger.info(`Generating report for Client UUID: ${data.clientUuid}`);

      const client = await this.getClient(data.clientUuid);

      if (!client) return { success: false };

      const providersData = await this.generateProvidersReports(data);

      const report = await this.saveReportEntity(data, client, providersData);

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

  private static async isSchedulingOptionActive(
    scheduleUuid: string,
  ): Promise<boolean> {
    const option = await database.em.findOne(SchedulingOption, {
      uuid: scheduleUuid,
    });
    return option?.isActive ?? false;
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
        console.error(error);
        logger.error(
          `Error processing ${providerConfig.provider} data:`,
          error,
        );
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

  // private static async generateAdAccountReports(
  //   data: ReportJobData,
  //   clientUuid: string,
  // ): Promise<any[]> {
  //   const adAccounts = await database.em.find(ClientFacebookAdAccount, {
  //     client: clientUuid,
  //   });
  //
  //   const reportPromises = adAccounts
  //     .map((adAccount) => {
  //       const metrics = data.adAccountMetrics.find(
  //         (m) => m.adAccountId === adAccount.adAccountId,
  //       );
  //
  //       if (!metrics) return null;
  //
  //       return FacebookDataUtil.getAllReportData(
  //         data.organizationUuid,
  //         adAccount.adAccountId,
  //         data.datePreset,
  //         metrics,
  //       ).then((reportData) => ({
  //         adAccountId: adAccount.adAccountId,
  //         ...reportData,
  //       }));
  //     })
  //     .filter(Boolean);
  //
  //   const adAccountReports = await Promise.all(reportPromises);
  //
  //   logger.info("Fetched all report data.");
  //   return adAccountReports;
  // }

  private static async saveReportEntity(
    data: ReportJobData,
    client: OrganizationClient,
    generatedReportData: ReportData[],
  ): Promise<Report> {
    const report = database.em.create(Report, {
      organization: client.organization,
      client,
      reportType: "facebook",
      reviewRequired: data.reviewRequired,
      gcsUrl: "",
      schedulingOption: data.scheduleUuid,
      data: generatedReportData,
      metadata: {
        timeZone: data.timeZone,
        datePreset: data.datePreset,
        loomLink: "",
        aiGeneratedContent: "",
        userReportDescription: "",
        messages: data.messages,
        images: {
          organizationLogoGsUri: data.images?.organizationLogo ?? "",
          clientLogoGsUri: data.images?.clientLogo ?? "",
        },
        reportName: data.reportName,
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
    const topic = report.reviewRequired
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
