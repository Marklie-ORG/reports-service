import { ReportsUtil } from "../utils/ReportsUtil.js";
import {
  Database,
  GCSWrapper,
  Log,
  MarklieError,
  OrganizationClient,
  Report,
  ScheduledJob,
  SchedulingOption,
  type SchedulingOptionWithImages,
} from "marklie-ts-core";
import { ReportQueueService } from "./ReportsQueueService.js";
import type {
  ReportJobData,
  ReportScheduleRequest,
  SchedulingOptionMetrics,
  SchedulingOptionWithExtras,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import { Temporal } from "@js-temporal/polyfill";
import { CronUtil } from "../utils/CronUtil.js";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("reports-service");

export class SchedulesService {
  async scheduleReport(
    scheduleOption: ReportScheduleRequest,
  ): Promise<string | void> {
    try {
      const client = await database.em.findOne(OrganizationClient, {
        uuid: scheduleOption.clientUuid,
      });

      if (!client) {
        throw MarklieError.notFound(
          "Client",
          scheduleOption.clientUuid,
          "reports-service",
        );
      }

      const schedule = new SchedulingOption();
      this.assignScheduleFields(schedule, scheduleOption, client);

      const jobPayload = this.buildJobPayload(
        scheduleOption,
        client,
        schedule.uuid,
      );

      const cronExpression =
        CronUtil.convertScheduleRequestToCron(scheduleOption);

      const job = await ReportQueueService.getInstance().scheduleReport(
        jobPayload,
        cronExpression,
      );

      if (!job) {
        throw MarklieError.notFound("Job", schedule.uuid, "Job was not found");
      }

      const scheduledJob = new ScheduledJob();
      scheduledJob.bullJobId = job.id as string;
      scheduledJob.schedulingOption = schedule;

      database.em.persist([schedule, scheduledJob]);
      await database.em.flush();

      return schedule.uuid;
    } catch (error) {
      if (error instanceof MarklieError) {
        throw error;
      }

      throw MarklieError.internal(
        "Failed to schedule report",
        {
          originalError:
            error instanceof Error ? error.message : "Unknown error",
        },
        "reports-service",
      );
    }
  }

  async updateSchedulingOption(
    uuid: string,
    scheduleOption: ReportScheduleRequest,
  ): Promise<string | void> {
    try {
      const schedule = await database.em.findOne(
        SchedulingOption,
        {
          uuid,
        },
        { populate: ["scheduledJob", "client"] },
      );

      if (!schedule) {
        throw new Error(`SchedulingOption ${uuid} not found`);
      }

      const queue = ReportQueueService.getInstance();

      if (schedule.scheduledJob?.bullJobId) {
        await queue.removeScheduledJob(schedule.scheduledJob.bullJobId);
      }

      const client = schedule.client;

      this.assignScheduleFields(schedule, scheduleOption, client);

      const jobPayload = this.buildJobPayload(
        scheduleOption,
        client,
        schedule.uuid,
      );
      const cronExpression =
        CronUtil.convertScheduleRequestToCron(scheduleOption);

      const job = await queue.scheduleReport(jobPayload, cronExpression);

      if (!job) {
        throw new Error("Job was not created");
      }

      let scheduledJob = schedule.scheduledJob;
      if (!scheduledJob) {
        scheduledJob = new ScheduledJob();
        scheduledJob.schedulingOption = schedule;
        schedule.scheduledJob = scheduledJob;
      }

      scheduledJob.bullJobId = job.id as string;
      scheduledJob.lastRunAt = null;

      await database.em.persistAndFlush(schedule);
      return cronExpression;
    } catch (e) {
      logger.error("Failed to update scheduling option:", e);
    }
  }

  async updateReportMetricsSelections(
    uuid: string,
    metricsSelections: SchedulingOptionMetrics,
  ) {
    const report = await database.em.findOne(Report, { uuid });

    if (!report) {
      throw new Error(`Report ${uuid} not found`);
    }

    report.metadata!.metricsSelections = metricsSelections;
    await database.em.persistAndFlush(report);
  }

  async getSchedulingOption(uuid: string): Promise<SchedulingOptionWithImages> {
    const gcs = GCSWrapper.getInstance("marklie-client-reports");
    const schedulingOption = await database.em.findOne(SchedulingOption, {
      uuid: uuid,
    });

    if (!schedulingOption || !schedulingOption.jobData?.images) {
      return {
        ...schedulingOption,
        images: {
          clientLogo: "",
          agencyLogo: "",
        },
      } as unknown as SchedulingOptionWithImages;
    }

    const clientLogo = schedulingOption.jobData.images.clientLogo
      ? await gcs.getSignedUrl(schedulingOption.jobData.images.clientLogo)
      : "";
    const agencyLogo = schedulingOption.jobData.images.agencyLogo
      ? await gcs.getSignedUrl(schedulingOption.jobData.images.agencyLogo)
      : "";

    return {
      ...schedulingOption,
      images: {
        clientLogo,
        agencyLogo,
      },
    } as unknown as SchedulingOptionWithImages;
  }

  async getSchedulingOptions(
    clientUuid: string,
  ): Promise<SchedulingOptionWithExtras[]> {
    const gcs = GCSWrapper.getInstance("marklie-client-reports");

    const schedulingOptions = await database.em.find(SchedulingOption, {
      client: clientUuid,
    });

    const sortedOptions = schedulingOptions.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    return Promise.all(
      sortedOptions.map(async (opt) => {
        const { images: imageData, time } = opt.jobData || {};
        const [hour, minute] = time?.split(":").map(Number) || [0, 0];

        const plainDate = ReportsUtil.getNextRunDate(
          opt.jobData as ReportScheduleRequest,
        ).toPlainDate();

        let formattedNextRun = "";
        let formattedLastRun = "";

        if (opt.timezone) {
          const zonedNext = plainDate.toZonedDateTime({
            timeZone: opt.timezone,
            plainTime: new Temporal.PlainTime(hour, minute),
          });

          formattedNextRun = zonedNext.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          });

          if (opt.lastRun) {
            const lastRunInstant = Temporal.Instant.from(
              opt.lastRun.toISOString(),
            );
            const zonedLastRun = lastRunInstant.toZonedDateTimeISO(
              opt.timezone,
            );

            formattedLastRun = zonedLastRun.toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            });
          }
        }

        const clientLogo = imageData?.clientLogo
          ? await gcs.getSignedUrl(imageData.clientLogo)
          : "";
        const organizationLogo = imageData?.organizationLogo
          ? await gcs.getSignedUrl(imageData.organizationLogo)
          : "";

        const images =
          clientLogo || organizationLogo
            ? { clientLogo, organizationLogo }
            : undefined;

        return {
          ...opt,
          nextRun: formattedNextRun,
          lastRun: formattedLastRun,
          frequency:
            opt.jobData!.frequency.charAt(0).toUpperCase() +
            opt.jobData!.frequency.slice(1),
          ...(images && { images }),
        };
      }),
    );
  }

  private assignScheduleFields(
    schedule: SchedulingOption,
    option: ReportScheduleRequest,
    client: OrganizationClient,
  ) {
    schedule.cronExpression = CronUtil.convertScheduleRequestToCron(option);
    schedule.client = database.em.getReference(OrganizationClient, client.uuid);
    schedule.jobData = option as any;
    schedule.timezone = option.timeZone;
    schedule.datePreset = option.datePreset;
    schedule.reportName = option.reportName || "";

    const [hour, minute] = option.time.split(":").map(Number);
    const plainDate = ReportsUtil.getNextRunDate(option).toPlainDate();

    const zonedDateTime = plainDate.toZonedDateTime({
      timeZone: option.timeZone,
      plainTime: new Temporal.PlainTime(hour, minute),
    });

    schedule.nextRun = new Date(zonedDateTime.epochMilliseconds);
  }

  private buildJobPayload(
    option: ReportScheduleRequest,
    client: OrganizationClient,
    scheduleUuid: string,
  ): ReportJobData {
    return {
      ...option,
      scheduleUuid,
      organizationUuid: client.organization.uuid,
    };
  }

  public async deleteSchedulingOption(uuid: string): Promise<void> {
    const schedulingOption = await database.em.findOne(
      SchedulingOption,
      {
        uuid,
      },
      { populate: ["scheduledJob"] },
    );

    if (!schedulingOption) throw new Error("Scheduling option not found");

    if (schedulingOption.scheduledJob) {
      const reportQueue = ReportQueueService.getInstance();

      await reportQueue.removeScheduledJob(
        schedulingOption.scheduledJob.bullJobId,
      );
      database.em.remove(schedulingOption.scheduledJob);
    }

    await database.em.removeAndFlush(schedulingOption);
  }

  public async stopSchedulingOption(uuid: string): Promise<void> {
    const schedulingOption = await database.em.findOne(
      SchedulingOption,
      {
        uuid,
      },
      { populate: ["scheduledJob"] },
    );

    if (!schedulingOption) throw new Error("Scheduling option not found");

    schedulingOption.isActive = false;

    if (schedulingOption.scheduledJob) {
      const reportQueue = ReportQueueService.getInstance();

      await reportQueue.removeScheduledJob(
        schedulingOption.scheduledJob.bullJobId,
      );
    }

    await database.em.persistAndFlush(schedulingOption);
  }
}
