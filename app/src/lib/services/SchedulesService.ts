import { ReportsUtil } from "../utils/ReportsUtil.js";
import {
  AdAccountCustomFormula,
  Database,
  GCSWrapper,
  Log,
  MarklieError,
  OrganizationClient,
  SchedulingOption,
} from "marklie-ts-core";
import { ReportQueueService } from "./ReportsQueueService.js";
import { Temporal } from "@js-temporal/polyfill";
import { CronUtil } from "../utils/CronUtil.js";
import { FacebookApi } from "../apis/FacebookApi.js";
import type {
  ISchedulingOption,
  ReportScheduleRequest,
  SchedulingOptionWithExtras,
} from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";
import { FACEBOOK_BASE_METRICS } from "../providers/facebook/FacebookMetricProcessor.js";

const logger = Log.getInstance().extend("schedules-service");

export class SchedulesService {
  async scheduleReport(
    scheduleOption: ReportScheduleRequest,
  ): Promise<string | void> {
    try {
      const database = await Database.getInstance();
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

      const cronExpression = schedule.schedule.cronExpression;
      const job = await ReportQueueService.getInstance().scheduleReport(
        { scheduleUuid: schedule.uuid },
        cronExpression,
        schedule.uuid, // deterministic job id
        schedule.schedule.timezone,
      );
      if (!job) {
        throw MarklieError.notFound("Job", schedule.uuid, "Job was not found");
      }

      schedule.schedule.jobId = String(job.id);
      database.em.persist(schedule);
      await database.em.flush();

      return schedule.uuid;
    } catch (error) {
      if (error instanceof MarklieError) throw error;
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
    const database = await Database.getInstance();

    return await database.em.transactional(async (em) => {
      const schedule = await em.findOne(
        SchedulingOption,
        { uuid },
        { populate: ["client", "client.organization"], refresh: true },
      );
      if (!schedule) throw MarklieError.notFound("Schedule was not found");

      const queue = ReportQueueService.getInstance();
      const oldJobId = schedule.schedule.jobId ?? undefined;

      this.assignScheduleFields(schedule, scheduleOption, schedule.client);

      const job = await queue.scheduleReport(
        { scheduleUuid: schedule.uuid },
        schedule.schedule.cronExpression,
        schedule.uuid,
        schedule.schedule.timezone,
      );
      if (!job || !job.id)
        throw MarklieError.internal("Job was not created or has invalid ID");

      schedule.schedule.jobId = String(job.id);
      schedule.schedule.nextRun = CronUtil.getNextRunDateFromCron(schedule);
      await em.persistAndFlush(schedule);

      if (oldJobId && oldJobId !== schedule.schedule.jobId) {
        try {
          await queue.removeScheduledJob(oldJobId);
        } catch (err) {
          logger.warn(`Failed to remove old job ${oldJobId}:`, err);
        }
      }

      return schedule.schedule.cronExpression;
    });
  }

  async getSchedulingOption(uuid: string): Promise<
    ISchedulingOption & {
      images?: { clientLogo?: string; organizationLogo?: string };
      schedule: ISchedulingOption["schedule"] & {
        dayOfWeek: string;
        time: string;
        frequency: "weekly" | "monthly" | "cron";
      };
    }
  > {
    const database = await Database.getInstance();
    const gcs = GCSWrapper.getInstance("marklie-client-reports");
    const opt = await database.em.findOne(SchedulingOption, { uuid });
    if (!opt) throw MarklieError.notFound("SchedulingOption", uuid);

    const clientLogo = opt.customization?.logos?.client?.gcsUri
      ? await gcs.getSignedUrl(opt.customization.logos.client.gcsUri)
      : undefined;
    const organizationLogo = opt.customization?.logos?.org?.gcsUri
      ? await gcs.getSignedUrl(opt.customization.logos.org.gcsUri)
      : undefined;
    const images =
      clientLogo || organizationLogo
        ? {
            ...(clientLogo ? { clientLogo } : {}),
            ...(organizationLogo ? { organizationLogo } : {}),
          }
        : undefined;

    const base = opt as unknown as ISchedulingOption;

    const tz = opt.schedule?.timezone || "UTC";
    const cron = (opt.schedule?.cronExpression || "").trim().toUpperCase();

    const nextRunDate = CronUtil.getNextRunDateFromCron(opt); // Date
    const zdt = Temporal.Instant.from(
      nextRunDate.toISOString(),
    ).toZonedDateTimeISO(tz);

    const time = `${String(zdt.hour).padStart(2, "0")}:${String(zdt.minute).padStart(2, "0")}`;
    const dayOfWeek = zdt.toLocaleString("en-US", { weekday: "long" });

    const frequency: "weekly" | "monthly" | "cron" =
      /^\d{1,2}\s+\d{1,2}\s+\*\s+\*\s+(MON|TUE|WED|THU|FRI|SAT|SUN)$/.test(cron)
        ? "weekly"
        : /^\d{1,2}\s+\d{1,2}\s+\d{1,2}\s+\*\s+\*$/.test(cron)
          ? "monthly"
          : "cron";

    const scheduleAugmented = {
      ...(base as any).schedule,
      dayOfWeek,
      time,
      frequency,
    };

    return {
      ...(base as any),
      ...(images ? { images } : {}),
      schedule: scheduleAugmented,
    };
  }

  async getSchedulingOptions(
    clientUuid: string,
  ): Promise<SchedulingOptionWithExtras[]> {
    const database = await Database.getInstance();

    const gcs = GCSWrapper.getInstance("marklie-client-reports");
    const options = await database.em.find(SchedulingOption, {
      client: clientUuid,
    });

    const sorted = options.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );

    return Promise.all(
      sorted.map(async (opt) => {
        const tz = opt.schedule.timezone || "UTC";

        let formattedNextRun = "";
        if (opt.schedule.nextRun) {
          const nextInst = Temporal.Instant.from(
            opt.schedule.nextRun.toISOString(),
          );
          formattedNextRun = nextInst
            .toZonedDateTimeISO(tz)
            .toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            });
        }

        let formattedLastRun = "";
        if (opt.schedule.lastRun) {
          const lastInst = Temporal.Instant.from(
            opt.schedule.lastRun.toISOString(),
          );
          formattedLastRun = lastInst
            .toZonedDateTimeISO(tz)
            .toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            });
        }

        const clientLogo = opt.customization?.logos?.client?.gcsUri
          ? await gcs.getSignedUrl(opt.customization.logos.client.gcsUri)
          : "";
        const organizationLogo = opt.customization?.logos?.org?.gcsUri
          ? await gcs.getSignedUrl(opt.customization.logos.org.gcsUri)
          : "";

        const images =
          clientLogo || organizationLogo
            ? { clientLogo, organizationLogo }
            : undefined;

        return {
          ...(opt as unknown as ISchedulingOption),
          schedule: {
            ...opt.schedule,
            nextRun: formattedNextRun,
            lastRun: formattedLastRun,
          },
          frequency: this.prettyFrequency(opt),
          ...(images && { images }),
        } as SchedulingOptionWithExtras;
      }),
    );
  }

  public async deleteSchedulingOptions(uuids: string[]): Promise<void> {
    const database = await Database.getInstance();

    const options = await database.em.find(SchedulingOption, {
      uuid: { $in: uuids },
    });

    const reportQueue = ReportQueueService.getInstance();
    for (const opt of options) {
      if (opt.schedule.jobId) {
        await reportQueue.removeScheduledJob(opt.schedule.jobId);
      }
      database.em.remove(opt);
    }
    await database.em.flush();
  }

  public async stopSchedulingOptions(uuids: string[]): Promise<void> {
    const database = await Database.getInstance();

    const options = await database.em.find(SchedulingOption, {
      uuid: { $in: uuids },
    });
    const reportQueue = ReportQueueService.getInstance();

    for (const opt of options) {
      opt.isActive = false;
      if (opt.schedule.jobId) {
        await reportQueue.removeScheduledJob(opt.schedule.jobId);
        opt.schedule.jobId = "";
      }
    }
    await database.em.persistAndFlush(options);
  }

  public async activateSchedulingOptions(uuids: string[]): Promise<void> {
    const database = await Database.getInstance();

    const options = await database.em.find(
      SchedulingOption,
      { uuid: { $in: uuids } },
      { populate: ["client"] },
    );
    const reportQueue = ReportQueueService.getInstance();

    for (const opt of options) {
      if (opt.isActive && opt.schedule.jobId) continue;

      opt.isActive = true;

      const newJob = await reportQueue.scheduleReport(
        { scheduleUuid: opt.uuid },
        opt.schedule.cronExpression,
        opt.uuid,
        opt.schedule.timezone,
      );
      if (!newJob)
        throw new Error(`Job not created for scheduling option ${opt.uuid}`);

      opt.schedule.jobId = String(newJob.id);
      opt.schedule.nextRun = CronUtil.getNextRunDateFromCron(opt);
    }

    await database.em.flush();
  }

  private async assignScheduleFields(
    schedule: SchedulingOption,
    option: ReportScheduleRequest,
    client: OrganizationClient,
  ) {
    const database = await Database.getInstance();

    const newSchedule: typeof schedule.schedule = {
      timezone: option.timeZone,
      datePreset: option.datePreset,
      cronExpression: CronUtil.convertScheduleRequestToCron(option),
    };

    if (schedule.schedule?.jobId) {
      newSchedule.jobId = schedule.schedule.jobId;
    }
    schedule.schedule = newSchedule;

    schedule.review = { required: option.reviewRequired };

    const logos: NonNullable<typeof schedule.customization>["logos"] = {};
    if (option.images?.clientLogo) {
      logos.client = { gcsUri: option.images.clientLogo };
    }
    if (option.images?.organizationLogo) {
      logos.org = { gcsUri: option.images.organizationLogo };
    }

    schedule.customization = {
      title: option.reportName || "",
      colors: {
        headerBg: option.colors?.headerBackgroundColor ?? "",
        reportBg: option.colors?.reportBackgroundColor ?? "",
      },
      ...(Object.keys(logos).length ? { logos } : {}),
    };

    const messaging: NonNullable<typeof schedule.messaging> = {};
    if (option.messages?.email) {
      messaging.email = {
        ...(option.messages.email.title
          ? { title: option.messages.email.title }
          : {}),
        ...(option.messages.email.body
          ? { body: option.messages.email.body }
          : {}),
      };
    }
    if (option.messages?.slack) messaging.slack = option.messages.slack;
    if (option.messages?.whatsapp)
      messaging.whatsapp = option.messages.whatsapp;
    if (Object.keys(messaging).length) {
      schedule.messaging = messaging;
    } else {
      delete (schedule as any).messaging;
    }

    schedule.providers = option.providers ?? [];
    schedule.client = database.em.getReference(OrganizationClient, client.uuid);

    const [hour, minute] = option.time.split(":").map(Number);
    const plainDate = ReportsUtil.getNextRunDate(option).toPlainDate();
    const zoned = plainDate.toZonedDateTime({
      timeZone: option.timeZone,
      plainTime: new Temporal.PlainTime(hour, minute),
    });
    schedule.schedule.nextRun = new Date(zoned.epochMilliseconds);
  }

  private prettyFrequency(opt: SchedulingOption): string {
    const cron = opt.schedule.cronExpression.trim().toUpperCase();
    if (
      /^\d{1,2}\s+\d{1,2}\s+\*\s+\*\s+(MON|TUE|WED|THU|FRI|SAT|SUN)$/.test(cron)
    ) {
      return "Weekly";
    }
    if (/^\d{1,2}\s+\d{1,2}\s+\d{1,2}\s+\*\s+\*$/.test(cron)) {
      return "Monthly";
    }
    return "Cron";
  }

  public async getAvailableMetricsForAdAccounts(clientUuid: string) {
    const database = await Database.getInstance();

    const client = await database.em.findOne(
      OrganizationClient,
      { uuid: clientUuid },
      { populate: ["organization", "adAccounts"], refresh: true },
    );
    if (!client) throw MarklieError.notFound("Client", clientUuid);

    const orgUuid = client.organization.uuid;
    const adAccounts = client.adAccounts?.getItems() ?? [];
    const adAccountIds = adAccounts.map((a) => a.adAccountId);

    // Build name lookup
    const nameById = new Map(
      adAccounts.map((a) => [a.adAccountId, a.adAccountName ?? ""]),
    );

    const [customMetricsByAdAccount, formulas] = await Promise.all([
      FacebookApi.create(orgUuid).then((api) =>
        api.getCustomConversionsForAdAccounts(adAccountIds),
      ),
      database.em.find(
        AdAccountCustomFormula,
        { adAccount: { adAccountId: { $in: adAccountIds } } },
        { populate: ["adAccount"] },
      ),
    ]);

    // Map formulas by adAccountId
    const formulasByAd: Record<string, { uuid: string; name: string }[]> = {};
    for (const f of formulas) {
      const id =
        "adAccount" in f ? f.adAccount.adAccountId : (f as any).adAccountId;
      if (!id) continue;
      if (!formulasByAd[id]) formulasByAd[id] = [];
      formulasByAd[id].push({ uuid: f.uuid, name: f.name });
    }

    // Base metrics same set for all sections
    const base = Object.keys(FACEBOOK_BASE_METRICS);

    // Build result
    return adAccountIds.map((adAccountId) => ({
      adAccountId,
      adAccountName: nameById.get(adAccountId) ?? "",
      adAccountMetrics: {
        kpis: base,
        graphs: base,
        ads: base,
        campaigns: base,
        customMetrics: (customMetricsByAdAccount[adAccountId] ?? [])
          .slice()
          .sort((a, b) =>
            a.name.localeCompare(b.name, undefined, {
              sensitivity: "base",
              numeric: true,
            }),
          ),
        customFormulas: (formulasByAd[adAccountId] ?? []).slice().sort((a, b) =>
          a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
            numeric: true,
          }),
        ),
      },
    }));
  }
}
