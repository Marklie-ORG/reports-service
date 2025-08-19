import { ReportsUtil } from "../utils/ReportsUtil.js";
import {
  ActivityLog,
  Database,
  GCSWrapper,
  Log,
  PubSubWrapper,
  Report,
  type ReportImages,
} from "marklie-ts-core";
import { Temporal } from "@js-temporal/polyfill";
import { ReportsConfigService } from "../config/config.js";
import { ReportQueueService } from "./ReportsQueueService.js";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("reports-service");
const config = ReportsConfigService.getInstance();

export class ReportsService {
  async getReport(uuid: string): Promise<Report | null> {
    return await database.em.findOne(
      Report,
      { uuid },
      { populate: ["client", "organization"] },
    );
  }

  async getReports(organizationUuid: string | undefined): Promise<Report[]> {
    if (!organizationUuid) {
      throw new Error("No organization Uuid");
    }
    return database.em.find(
      Report,
      { organization: organizationUuid },
      { populate: ["client"] },
    );
  }

  async getClientReports(clientUuid: string): Promise<Report[]> {
    return database.em.find(
      Report,
      { client: clientUuid },
      {
        orderBy: { createdAt: "DESC" },
        populate: ["client", "schedulingOption"],
      },
    );
  }

  async sendReportAfterReview(uuid: string, sendAt?: string) {
    const report = await database.em.findOne(Report, { uuid });
    if (!report) throw new Error(`Report ${uuid} not found`);

    const clientTimeZone = report.metadata?.timeZone ?? "UTC";

    const pdfBuffer = await ReportsUtil.generateReportPdf(uuid);
    const filePath = ReportsUtil.generateFilePath(
      report.client.uuid,
      report.metadata?.datePreset,
    );

    const gcs = GCSWrapper.getInstance(config.get("GCS_REPORTS_BUCKET"));
    report.gcsUrl = await gcs.uploadBuffer(
      pdfBuffer,
      filePath,
      "application/pdf",
      false,
      false,
    );

    report.reviewedAt = new Date();

    await database.em.flush();

    const payload = {
      clientUuid: report.client.uuid,
      organizationUuid: report.organization.uuid,
      reportUuid: report.uuid,
      messages: report.metadata?.messages,
    };

    if (sendAt) {
      const plainDateTime = Temporal.PlainDateTime.from(sendAt);
      const sendAtZoned = plainDateTime.toZonedDateTime(clientTimeZone);
      const delayMs =
        sendAtZoned.epochMilliseconds -
        Temporal.Now.instant().epochMilliseconds;

      if (delayMs > 0) {
        logger.info(
          `Delaying report delivery to ${sendAtZoned.toString()} (${delayMs}ms)`,
        );

        await ReportQueueService.getInstance().scheduleOneTimeReport(
          payload,
          delayMs,
        );
      } else {
        logger.warn("sendAt is in the past, sending immediately");
        await PubSubWrapper.publishMessage("notification-send-report", payload);
      }
    } else {
      logger.info("Sending reviewed report immediately");
      await PubSubWrapper.publishMessage("notification-send-report", payload);
    }

    const log = database.em.create(ActivityLog, {
      organization: report.organization.uuid,
      action: "report_reviewed",
      targetType: "report",
      targetUuid: report.uuid,
      client: report.client.uuid,
      metadata: { frequency: "" },
      actor: "system",
    });

    await database.em.persistAndFlush(log);
  }

  async updateReportImages(uuid: string, images: ReportImages) {
    const report = await database.em.findOne(Report, { uuid });

    if (!report) {
      throw new Error(`Report ${uuid} not found`);
    }

    report.metadata!.images = images;
    await database.em.persistAndFlush(report);
  }
}
