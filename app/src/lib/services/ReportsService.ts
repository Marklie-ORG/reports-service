import type { Job } from "bullmq";
import { ReportsUtil } from "../utils/ReportsUtil.js";
import {
    ActivityLog,
    Database,
    GCSWrapper,
    Log,
    OrganizationClient, PubSubWrapper,
    Report,
    SchedulingOption,
} from "marklie-ts-core";
import type {
  ReportScheduleRequest,
  SchedulingOptionMetrics,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import { CronUtil } from "../utils/CronUtil.js";
import { ReportQueueService } from "./ReportsQueueService.js";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("reports-service");

export class ReportsService {
  async scheduleReport(
    scheduleOption: ReportScheduleRequest,
  ): Promise<string | void> {
    try {
      const schedule = new SchedulingOption();

      const cronExpression =
        CronUtil.convertScheduleRequestToCron(scheduleOption);

      schedule.cronExpression = cronExpression;
      schedule.client = database.em.getReference(
        OrganizationClient,
        scheduleOption.clientUuid,
      );

      const client = await database.em.findOne(OrganizationClient, {
        uuid: scheduleOption.clientUuid,
      });

      const queue = ReportQueueService.getInstance();

      const job: Job = await queue.scheduleReport(
        {
          ...scheduleOption,
          organizationUuid: client.organization.uuid,
          accountId: client?.accountId,
          reviewNeeded: scheduleOption.reviewNeeded,
          datePreset: scheduleOption.datePreset,
          timeZone: scheduleOption.timeZone,
          metrics: scheduleOption.metrics,
          messages: scheduleOption.messages,
        },
        cronExpression,
      );

      //todo: add timezones
      schedule.reportType = scheduleOption.frequency;
      schedule.jobData = scheduleOption as any;
      schedule.timezone = scheduleOption.timeZone;
      schedule.datePreset = scheduleOption.datePreset;
      schedule.bullJobId = job.id as string;
      schedule.reportName = scheduleOption.reportName;
      schedule.nextRun = ReportsUtil.getNextRunDate(scheduleOption).toJSDate();

      await database.em.persistAndFlush(schedule);

      return schedule.uuid;
    } catch (e) {
      logger.error(e);
    }
  }

  async updateSchedulingOption(
    uuid: string,
    scheduleOption: ReportScheduleRequest,
  ): Promise<string | void> {
    try {
      const schedulingOption = await database.em.findOne(SchedulingOption, {
        uuid: uuid,
      });

      const cronExpression =
        CronUtil.convertScheduleRequestToCron(scheduleOption);

      schedulingOption.cronExpression = cronExpression;

      schedulingOption.client = database.em.getReference(
        OrganizationClient,
        schedulingOption.client.uuid,
      );

      scheduleOption.clientUuid = schedulingOption.client.uuid;

      const client = await database.em.findOne(OrganizationClient, {
        uuid: schedulingOption.client.uuid,
      });

      const queue = ReportQueueService.getInstance();

      await queue.removeScheduledJob(schedulingOption.bullJobId);

      const job: Job = await queue.scheduleReport(
        {
          ...scheduleOption,
          organizationUuid: client.organization.uuid,
          accountId: client?.accountId,
          reviewNeeded: scheduleOption.reviewNeeded,
          datePreset: scheduleOption.datePreset,
          timeZone: scheduleOption.timeZone,
          metrics: scheduleOption.metrics,
          messages: scheduleOption.messages,
        },
        cronExpression,
      );

      //todo: add timezones
      schedulingOption.reportType = scheduleOption.frequency;
      schedulingOption.jobData = scheduleOption as any;
      schedulingOption.timezone = scheduleOption.timeZone;
      schedulingOption.datePreset = scheduleOption.datePreset;
      schedulingOption.bullJobId = job.id as string;
      schedulingOption.nextRun =
        ReportsUtil.getNextRunDate(scheduleOption).toJSDate();

      await database.em.persistAndFlush(schedulingOption);

      return cronExpression;
    } catch (e) {
      logger.error(e);
    }
  }

  async getReport(uuid: string) {
    return database.em.findOne(Report, { uuid: uuid });
  }

  async getReports(uuid: string) {
    return database.em.find(
      Report,
      { organization: uuid },
      { populate: ["client"] },
    );
  }

  async getSchedulingOption(uuid: string) {
    return database.em.findOne(SchedulingOption, { uuid: uuid });
  }

  async updateReportMetricsSelections(
    uuid: string,
    metricsSelections: SchedulingOptionMetrics,
  ) {
    const report = await database.em.findOne(Report, { uuid: uuid });
    report.metadata.metricsSelections = metricsSelections;
    await database.em.persistAndFlush(report);
  }

  async sendReportAfterReview(uuid: string) {
    const report = await database.em.findOne(Report, { uuid: uuid });
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
    await database.em.flush();

      const payload = {
          clientUuid: report.client.uuid,
          organizationUuid: report.organization.uuid,
          reportUuid: report.uuid,
          messages: report.metadata.messages
      };

      logger.info("Sending to notification.")

      await PubSubWrapper.publishMessage('notification-send-report', payload);

      const log = database.em.create(ActivityLog, {
          organization: report.organization.uuid,
          action: 'report_reviewed',
          targetType: 'report',
          targetUuid: report.uuid,
          client: report.client.uuid,
          metadata: {
              frequency: ""
          },
          actor: 'system'
      });

      await database.em.persistAndFlush(log);
  }
}
