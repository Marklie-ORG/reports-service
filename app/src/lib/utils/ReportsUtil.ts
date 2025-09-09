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
import puppeteer, { type LaunchOptions } from "puppeteer";
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
      logger.info(`Generating report for Client UUID: ${data.clientUuid}`);

      const client = await this.getClient(data.clientUuid);

      if (!client) return { success: false };

      const providersData = await this.generateProvidersReports(data);

      const schedulingOption = await database.em.findOne(SchedulingOption, {
        uuid: data.scheduleUuid,
      });
      data.pdfFilename = this.generatePdfFilename(
        schedulingOption as SchedulingOption,
      );

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

  private static generatePdfFilename(
    schedulingOption: SchedulingOption,
  ): string {
    if (!schedulingOption.nextRun) {
      return "Report";
    }
    const date = new Date(schedulingOption.nextRun);
    const day = String(date.getUTCDate()).padStart(2, "0");
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const year = String(date.getUTCFullYear()).slice(-2);
    const formatted = `${day}.${month}.${year}`;
    return formatted + " " + schedulingOption.client.name;
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
        pdfFilename: data.pdfFilename ?? "",
        colors: data.colors ?? null,
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
      logger.error(error.response.data);
    } else {
      logger.error("Failed to process scheduled report job:", error);
      console.error(error);
    }
  }

  public static async generateReportPdf(reportUuid: string): Promise<Buffer> {
    // --- Resolve base URL from ENV ---
    const env = (process.env.ENVIRONMENT || "").toLowerCase();
    const baseUrl =
      env === "production"
        ? "https://marklie.com"
        : env === "staging"
          ? "https://staging.marklie.com"
          : "http://localhost:4200";

    // --- Launch options (Cloud Run friendly) ---
    const sleep = (ms: number) =>
      new Promise<void>((res) => setTimeout(res, ms));

    // Build launch options compatible with your typings
    const cfg = (config.getPuppeteerConfig?.() ?? {}) as LaunchOptions;
    const launchOpts: LaunchOptions & {
      ignoreHTTPSErrors?: boolean;
    } = {
      ...cfg,
      headless: true, // <- "new" not allowed by your types
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
        ...((cfg as any).args ?? []),
      ],
      // If your typings don’t include this, it’s ok because we augmented the type above.
      // Flip to true temporarily if your staging cert is not valid yet.
      ignoreHTTPSErrors: false,
      // DO NOT set "timeout" here: it isn't a LaunchOptions prop in your types
    };

    const browser = await puppeteer.launch(launchOpts);

    try {
      const page = await browser.newPage();

      // Be more "browser-like"
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/124.0.0.0 Safari/537.36",
      );
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

      // Log useful signals
      page.on("console", (m) => console.log("[page]", m.type(), m.text()));
      page.on("requestfailed", (r) =>
        console.error("[req failed]", r.url(), r.failure()?.errorText),
      );
      page.on("response", (r) => {
        if (r.status() >= 400) console.error("[resp]", r.status(), r.url());
      });

      // Block 3rd-party noise (FB SDK, fonts, GoDaddy trackers, etc.)
      await page.setRequestInterception(true);
      const allowedHost = new URL(baseUrl).host;
      page.on("request", (req) => {
        try {
          const { host } = new URL(req.url());
          if (host === allowedHost) return req.continue();
          return req.abort(); // deny cross-origin requests
        } catch {
          return req.continue();
        }
      });

      page.setDefaultTimeout(120_000);
      page.setDefaultNavigationTimeout(120_000);

      const url = `${baseUrl}/pdf-report/${reportUuid}`;
      console.log("Navigating to:", url);

      // A tiny helper to retry navigation once if first attempt is blocked/challenged
      const nav = async () => {
        try {
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 90_000,
          });
        } catch (e) {
          console.warn("First navigation failed, retrying once...", e);
          await sleep(1500);
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 90_000,
          });
        }
      };

      await nav();

      // Wait for the app to render the report DOM
      await page.waitForSelector(".report-container", { timeout: 60_000 });

      // Ensure fonts (better layout in PDF)
      try {
        await page.evaluate(() => (document as any).fonts?.ready);
      } catch {}

      // Give charts/animations a moment to settle
      await sleep(1500);

      // Measure robust height (fallback to a sane max)
      const dashboardHeight = await page.evaluate(() => {
        const el = document.querySelector(
          ".report-container",
        ) as HTMLElement | null;
        const body = document.body;
        const html = document.documentElement;
        const docHeight = Math.max(
          body?.scrollHeight || 0,
          body?.offsetHeight || 0,
          html?.clientHeight || 0,
          html?.scrollHeight || 0,
          html?.offsetHeight || 0,
        );
        const elHeight = el ? el.scrollHeight : 0;
        return Math.max(elHeight, docHeight, 2000);
      });

      const pdf = await page.pdf({
        printBackground: true,
        width: "1600px",
        height: `${Math.min(dashboardHeight, 30_000)}px`, // guard against absurd heights
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
