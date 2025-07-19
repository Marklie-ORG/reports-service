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

const database = await Database.getInstance();
const logger = Log.getInstance().extend("reports-service");
const config = ReportsConfigService.getInstance();

export class ReportsService {
  async getReport(uuid: string): Promise<Report | null> {
    return database.em.findOne(Report, { uuid });
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

  async sendReportAfterReview(uuid: string) {
    const report = await database.em.findOne(Report, { uuid });
    if (!report) throw new Error(`Report ${uuid} not found`);

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
    const plainDate = Temporal.Now.zonedDateTimeISO(
      report.metadata?.timeZone,
    ).toPlainDate();
    report.reviewedAt = new Date(
      plainDate.toZonedDateTime({
        timeZone: report.metadata?.timeZone,
        plainTime: "00:00",
      }).epochMilliseconds,
    );

    await database.em.flush();

    const payload = {
      clientUuid: report.client.uuid,
      organizationUuid: report.organization.uuid,
      reportUuid: report.uuid,
      messages: report.metadata?.messages,
    };

    logger.info("Sending reviewed report to notification service.");
    await PubSubWrapper.publishMessage("notification-send-report", payload);

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
  
  async updateReportImages(
    uuid: string,
    images: ReportImages,
  ) {
    const report = await database.em.findOne(Report, { uuid });

    if (!report) {
      throw new Error(`Report ${uuid} not found`);
    }

    report.metadata!.images = images;
    await database.em.persistAndFlush(report);
  }

}
