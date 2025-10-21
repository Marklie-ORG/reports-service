import {
  Database,
  FACEBOOK_DATE_PRESETS,
  OrganizationClient,
  type ProviderConfig,
  SchedulingOption,
  SchedulingTemplate,
} from "marklie-ts-core";
import type { ReportScheduleRequest } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces";
import { ReportQueueService } from "./ReportsQueueService";
import { ReportsUtil } from "../utils/ReportsUtil.js";
import { CronUtil } from "../utils/CronUtil.js";
import { Temporal } from "@js-temporal/polyfill";

const database = await Database.getInstance();
const em = database.em.fork();

export class SchedulingTemplateService {
  constructor(private readonly queue = ReportQueueService.getInstance()) {}

  async createOptionFromTemplate(
    templateUuid: string,
    clientUuid: string,
    overrides?: Partial<{
      reportName: string;
      timezone: string;
      datePreset: FACEBOOK_DATE_PRESETS;
      providers: ProviderConfig[];
      reviewRequired: boolean;
      time: string;
      dayOfWeek: string;
      dayOfMonth: number;
      intervalDays: number;
      cronExpression?: string;
    }>,
  ): Promise<SchedulingOption> {
    const [template, client] = await Promise.all([
      em.findOneOrFail(SchedulingTemplate, { uuid: templateUuid }),
      em.findOneOrFail(
        OrganizationClient,
        { uuid: clientUuid },
        { populate: ["organization"] },
      ),
    ]);

    const dj = (template.defaultJobData ?? {}) as any;
    const templateTz: string | undefined =
      (template as any).timeZone ?? (template as any).timezone;

    const base = {
      clientUuid: client.uuid,
      organizationUuid: client.organization.uuid,
      reportName: overrides?.reportName ?? template.name ?? "",
      reviewRequired:
        overrides?.reviewRequired ?? template.reviewRequired ?? false,
      datePreset: overrides?.datePreset ?? template.datePreset,
      messages: {
        email: {
          title: dj?.messages?.email?.title ?? "",
          body: dj?.messages?.email?.body ?? "",
        },
        slack: dj?.messages?.slack ?? "",
        whatsapp: dj?.messages?.whatsapp ?? "",
      },
      colors: {
        headerBackgroundColor: dj?.colors?.headerBackgroundColor ?? "",
        reportBackgroundColor: dj?.colors?.reportBackgroundColor ?? "",
      },
      providers: overrides?.providers ?? template.providers ?? [],
      time: overrides?.time ?? template.time ?? "09:00",
      timeZone: overrides?.timezone ?? templateTz ?? "UTC",
    } as const;

    const isCron = !!(overrides?.cronExpression || template.cronExpression);
    const freq = isCron ? "cron" : template.frequency;

    let req: ReportScheduleRequest;

    switch (freq) {
      case "weekly":
      case "biweekly": {
        req = {
          ...base,
          frequency: freq,
          dayOfWeek: (overrides?.dayOfWeek ?? template.dayOfWeek) as
            | "Monday"
            | "Tuesday"
            | "Wednesday"
            | "Thursday"
            | "Friday"
            | "Saturday"
            | "Sunday",
        };
        break;
      }
      case "monthly": {
        req = {
          ...base,
          frequency: "monthly",
          dayOfMonth: overrides?.dayOfMonth ?? template.dayOfMonth ?? 1,
        };
        break;
      }
      case "custom": {
        req = {
          ...base,
          frequency: "custom",
          intervalDays: overrides?.intervalDays ?? template.intervalDays ?? 1,
        };
        break;
      }
      case "cron":
      default: {
        req = {
          ...base,
          frequency: "cron",
          cronExpression:
            overrides?.cronExpression ?? (template.cronExpression as string),
        };
        break;
      }
    }

    const option = new SchedulingOption();
    option.client = em.getReference(OrganizationClient, client.uuid);
    option.isActive = true;
    option.providers = req.providers ?? [];

    option.review = { required: req.reviewRequired };

    option.schedule = {
      timezone: req.timeZone,
      datePreset: req.datePreset,
      cronExpression: CronUtil.convertScheduleRequestToCron(req),
    };

    const [hour, minute] = req.time.split(":").map(Number);
    const plainDate = ReportsUtil.getNextRunDate(req).toPlainDate();
    const zoned = plainDate.toZonedDateTime({
      timeZone: req.timeZone,
      plainTime: new Temporal.PlainTime(hour, minute),
    });
    option.schedule.nextRun = new Date(zoned.epochMilliseconds);

    option.customization = {
      title: req.reportName || "",
      colors: {
        headerBg: (req as any).colors?.headerBackgroundColor ?? "",
        reportBg: (req as any).colors?.reportBackgroundColor ?? "",
      },
      logos: {
        ...(req.images?.clientLogo
          ? { client: { gcsUri: req.images.clientLogo } }
          : {}),
        ...(req.images?.organizationLogo
          ? { org: { gcsUri: req.images.organizationLogo } }
          : {}),
      },
    };

    option.messaging = {
      ...(req.messages?.email
        ? {
            email: {
              title: req.messages.email.title,
              body: req.messages.email.body,
            },
          }
        : {}),
      ...(req.messages?.slack ? { slack: req.messages.slack } : {}),
      ...(req.messages?.whatsapp ? { whatsapp: req.messages.whatsapp } : {}),
    };

    await em.persistAndFlush(option);

    // Enqueue recurring job; use schedule uuid as deterministic job id
    const job = await this.queue.scheduleReport(
      { scheduleUuid: option.uuid },
      option.schedule.cronExpression,
      option.uuid,
      option.schedule.timezone,
    );
    if (!job) throw new Error("Job was not created");

    option.schedule.jobId = String(job.id);
    await em.persistAndFlush(option);

    return option;
  }
}
