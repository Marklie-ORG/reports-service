import { CronUtil } from "lib/utils/CronUtil";
import { ReportsUtil } from "../utils/ReportsUtil.js";
import {
  ActivityLog,
  Database,
  GCSWrapper,
  Log,
  OrganizationClient,
  PubSubWrapper,
  ScheduledJob,
  SchedulingOption,
} from "marklie-ts-core";
import { ReportQueueService } from "./ReportsQueueService.js";
import type {
  ReportScheduleRequest,
  SchedulingOptionMetrics,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import { Temporal } from "@js-temporal/polyfill";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("reports-service");

export class ReportsService {
  async scheduleReport(
    scheduleOption: ReportScheduleRequest,
  ): Promise<string | void> {
    try {
      const client = await database.em.findOne(OrganizationClient, {
        uuid: scheduleOption.clientUuid,
      });

      if (!client) {
        logger.error(`Client with UUID ${scheduleOption.clientUuid} not found`);
        return;
      }

      const schedule = new SchedulingOption();
      this.assignScheduleFields(schedule, scheduleOption, client);

      const jobPayload = this.buildJobPayload(scheduleOption, client);
      const cronExpression =
        CronUtil.convertScheduleRequestToCron(scheduleOption);
      const job = await ReportQueueService.getInstance().scheduleReport(
        jobPayload,
        cronExpression,
      );

      const scheduledJob = new ScheduledJob();
      scheduledJob.bullJobId = job.id as string;
      scheduledJob.schedulingOption = schedule;

      database.em.persist([schedule, scheduledJob]);
      await database.em.flush();

      return schedule.uuid;
    } catch (e) {
      logger.error("Failed to schedule report:", e);
    }
  }

  async updateSchedulingOption(
    uuid: string,
    scheduleOption: ReportScheduleRequest,
  ): Promise<string | void> {
    try {
      const schedule = await database.em.findOne(SchedulingOption, { uuid });
      if (!schedule) throw new Error(`SchedulingOption ${uuid} not found`);

      const client = await database.em.findOne(OrganizationClient, {
        uuid: schedule.client.uuid,
      });

      if (!client)
        throw new Error(`Client with UUID ${schedule.client.uuid} not found`);

      const queue = ReportQueueService.getInstance();
      await queue.removeScheduledJob(schedule.bullJobId);

      this.assignScheduleFields(schedule, scheduleOption, client);

      const jobPayload = this.buildJobPayload(scheduleOption, client);
      const cronExpression =
        CronUtil.convertScheduleRequestToCron(scheduleOption);
      const job = await queue.scheduleReport(jobPayload, cronExpression);

      schedule.bullJobId = job.id as string;

      await database.em.persistAndFlush(schedule);
      return cronExpression;
    } catch (e) {
      logger.error("Failed to update scheduling option:", e);
    }
  }

  async getReport(uuid: string) {
    return database.em.findOne(Report, { uuid });
  }

  async getReports(organizationUuid: string) {
    return database.em.find(
      Report,
      { organization: organizationUuid },
      { populate: ["client"] },
    );
  }

  async getSchedulingOption(uuid: string) {
    return database.em.findOne(SchedulingOption, { uuid });
  }

  async updateReportMetricsSelections(
    uuid: string,
    metricsSelections: SchedulingOptionMetrics,
  ) {
    const report = await database.em.findOne(Report, { uuid });
    if (!report) throw new Error(`Report ${uuid} not found`);
    report.metadata.metricsSelections = metricsSelections;
    await database.em.persistAndFlush(report);
  }

  async sendReportAfterReview(uuid: string) {
    const report = await database.em.findOne(Report, { uuid });
    if (!report) throw new Error(`Report ${uuid} not found`);

    const pdfBuffer = await ReportsUtil.generateReportPdf(uuid);
    const filePath = ReportsUtil.generateFilePath(
      report.client.uuid,
      report.metadata.datePreset,
    );

    const gcs = GCSWrapper.getInstance("marklie-client-reports");
    report.gcsUrl = await gcs.uploadBuffer(
      pdfBuffer,
      filePath,
      "application/pdf",
      false,
      false,
    );
    report.reviewedAt = Temporal.Now.zonedDateTimeISO(
      report.metadata.timeZone,
    ).toString();

    await database.em.flush();

    const payload = {
      clientUuid: report.client.uuid,
      organizationUuid: report.organization.uuid,
      reportUuid: report.uuid,
      messages: report.metadata.messages,
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

  private assignScheduleFields(
    schedule: SchedulingOption,
    option: ReportScheduleRequest,
    client: OrganizationClient,
  ) {
    schedule.cronExpression = CronUtil.convertScheduleRequestToCron(option);
    schedule.client = database.em.getReference(OrganizationClient, client.uuid);
    schedule.reportType = option.frequency;
    schedule.jobData = option as any;
    schedule.timezone = option.timeZone;
    schedule.datePreset = option.datePreset;
    schedule.reportName = option.reportName;
    schedule.nextRun = ReportsUtil.getNextRunDate(option).toString();
  }

  private buildJobPayload(
    option: ReportScheduleRequest,
    client: OrganizationClient,
  ) {
    return {
      ...option,
      organizationUuid: client.organization.uuid,
      accountId: client.accountId,
    };
  }
}
