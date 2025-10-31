import {
  Database,
  FACEBOOK_DATE_PRESETS,
  Organization,
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
import type { TemplateOrigin } from "marklie-ts-core/dist/lib/entities/SchedulingTemplate";
import { TemplateVisibility } from "marklie-ts-core/dist/lib/entities/SchedulingTemplate.js";

type DayOfWeek =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";
type Frequency = "weekly" | "biweekly" | "monthly" | "custom" | "cron";

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
      dayOfWeek: DayOfWeek;
      dayOfMonth: number;
      intervalDays: number;
      cronExpression: string;
    }>,
  ): Promise<SchedulingOption> {
    const database = await Database.getInstance();
    const em = database.em.fork();
    const [template, client] = await Promise.all([
      em.findOneOrFail(SchedulingTemplate, { uuid: templateUuid }),
      em.findOneOrFail(
        OrganizationClient,
        { uuid: clientUuid },
        { populate: ["organization", "adAccounts"] },
      ),
    ]);

    const tplSched = template.schedule;
    const tplCust = template.customization;
    const tplMsg = template.messaging;
    const tplRev = template.review;

    const providersForClient = this.buildProvidersForClient(
      template.providers,
      client,
    );

    const base = {
      clientUuid: client.uuid,
      organizationUuid: client.organization.uuid,
      reportName: overrides?.reportName ?? template.name ?? "",
      reviewRequired: overrides?.reviewRequired ?? tplRev?.required ?? false,
      datePreset: overrides?.datePreset ?? tplSched.datePreset,
      messages: {
        email: {
          title: tplMsg?.email?.title ?? "",
          body: tplMsg?.email?.body ?? "",
        },
        slack: tplMsg?.slack ?? "",
        whatsapp: tplMsg?.whatsapp ?? "",
      },
      colors: {
        headerBackgroundColor: tplCust?.colors?.headerBg ?? "",
        reportBackgroundColor: tplCust?.colors?.reportBg ?? "",
      },
      providers: providersForClient,
      time: overrides?.time ?? tplSched.time ?? "09:00",
      timeZone: overrides?.timezone ?? tplSched.timezone ?? "UTC",
    } as const;

    const isCron = !!(
      overrides?.cronExpression ||
      tplSched.cronExpression ||
      tplSched.frequency === "cron"
    );
    const freq: Frequency = isCron ? "cron" : (tplSched.frequency as Frequency);

    let req: ReportScheduleRequest;

    switch (freq) {
      case "weekly":
      case "biweekly": {
        req = {
          ...base,
          frequency: freq,
          dayOfWeek: (overrides?.dayOfWeek ?? tplSched.dayOfWeek) as DayOfWeek,
        };
        break;
      }
      case "monthly": {
        req = {
          ...base,
          frequency: "monthly",
          dayOfMonth: overrides?.dayOfMonth ?? tplSched.dayOfMonth ?? 1,
        };
        break;
      }
      case "custom": {
        req = {
          ...base,
          frequency: "custom",
          intervalDays: overrides?.intervalDays ?? tplSched.intervalDays ?? 1,
        };
        break;
      }
      case "cron":
      default: {
        req = {
          ...base,
          frequency: "cron",
          cronExpression:
            overrides?.cronExpression ?? tplSched.cronExpression ?? "0 9 * * 1",
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
        headerBg: base.colors.headerBackgroundColor,
        reportBg: base.colors.reportBackgroundColor,
      },
      logos: {
        ...(tplCust?.logos?.client
          ? { client: { ...tplCust.logos.client } }
          : {}),
        ...(tplCust?.logos?.org ? { org: { ...tplCust.logos.org } } : {}),
      },
    };

    option.messaging = {
      ...(tplMsg?.email
        ? {
            email: {
              title: tplMsg.email.title ?? "",
              body: tplMsg.email.body ?? "",
            },
          }
        : {}),
      ...(tplMsg?.slack ? { slack: tplMsg.slack } : {}),
      ...(tplMsg?.whatsapp ? { whatsapp: tplMsg.whatsapp } : {}),
      ...(tplMsg?.pdfFilename ? { pdfFilename: tplMsg.pdfFilename } : {}),
    };

    await em.persistAndFlush(option);

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

  private buildProvidersForClient(
    tplProviders: ProviderConfig[] | undefined,
    client: OrganizationClient,
  ): ProviderConfig[] {
    const accounts = client?.adAccounts ?? [];

    if (!tplProviders?.length || !accounts.length) {
      return tplProviders ?? [];
    }

    return tplProviders.map((prov) => ({
      ...prov,
      sections: (prov.sections ?? []).map((sec) => {
        const base = (sec.adAccounts?.[0] ?? {}) as any;

        const adAccounts = accounts.map((acc, i) => ({
          ...base,
          order: i,
          enabled: true,
          adAccountId: acc.adAccountId,
          adAccountName: acc.adAccountName,
          currency: base?.currency ?? "€",
          metrics: base?.metrics ?? [],
          customMetrics: base?.customMetrics ?? [],
          customFormulas: base?.customFormulas ?? [],
          // keep either ads/campaigns settings if present
          adsSettings: base?.adsSettings,
          campaignsSettings: base?.campaignsSettings,
        }));

        return { ...sec, adAccounts };
      }),
    }));
  }

  async createTemplateFromOption(
    optionUuid: string,
    params?: Partial<{
      name: string;
      description: string;
      origin: TemplateOrigin;
      visibility: TemplateVisibility;
      organizationUuid: string | null;
    }>,
  ): Promise<SchedulingTemplate> {
    const database = await Database.getInstance();
    const em = database.em.fork();
    const option = await em.findOneOrFail(
      SchedulingOption,
      { uuid: optionUuid },
      {
        populate: ["client"],
      },
    );

    const collapseSections = (prov: ProviderConfig) =>
      (prov.sections ?? []).map((sec) => {
        const base = (sec.adAccounts?.[0] ?? {}) as any;
        const blueprint = {
          enabled: true,
          order: 0,
          adAccountId: "",
          adAccountName: "",
          currency: base?.currency ?? "€",
          metrics: base?.metrics ?? [],
          customMetrics: base?.customMetrics ?? [],
          customFormulas: base?.customFormulas ?? [],
          adsSettings: base?.adsSettings,
          campaignsSettings: base?.campaignsSettings,
        };
        return { ...sec, adAccounts: [blueprint] };
      });

    const cron = option.schedule.cronExpression;
    let timeFromCron: string | undefined;
    const m = /^(\S+)\s+(\S+)\s+\S+\s+\S+\s+\S+/.exec(cron || "");
    if (m) {
      const [min, hour] = [m[1], m[2]];
      if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
        timeFromCron = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      }
    }

    const tpl = new SchedulingTemplate();
    tpl.name =
      params?.name ?? (option.customization?.title || "Untitled template");

    tpl.schedule = {
      timezone: option.schedule.timezone,
      datePreset: option.schedule.datePreset,
      frequency: "cron",
      cronExpression: option.schedule.cronExpression,
      time: timeFromCron ?? "09:00",
      dayOfWeek: undefined,
      dayOfMonth: undefined,
      intervalDays: undefined,
    } as any;

    tpl.providers = (option.providers ?? []).map((p) => ({
      ...p,
      sections: collapseSections(p),
    }));

    tpl.review = { required: option.review?.required ?? false } as any;

    tpl.customization = {
      colors: {
        headerBg: option.customization?.colors?.headerBg,
        reportBg: option.customization?.colors?.reportBg,
      },
      logos: option.customization?.logos
        ? {
            client: option.customization.logos.client
              ? { ...option.customization.logos.client }
              : undefined,
            org: option.customization.logos.org
              ? { ...option.customization.logos.org }
              : undefined,
          }
        : undefined,
      title: option.customization?.title,
    } as any;

    tpl.messaging = {
      email: option.messaging?.email
        ? {
            title: option.messaging.email.title ?? "",
            body: option.messaging.email.body ?? "",
          }
        : undefined,
      slack: option.messaging?.slack,
      whatsapp: option.messaging?.whatsapp,
      pdfFilename: option.messaging?.pdfFilename,
    } as any;

    if ("origin" in tpl && params?.origin) tpl.origin = params.origin ?? "user";
    if ("visibility" in tpl && params?.visibility)
      tpl.visibility = params.visibility ?? "org";
    if ("organization" in tpl && params?.organizationUuid) {
      tpl.organization = em.getReference(Organization, params.organizationUuid);
    }

    await em.persistAndFlush(tpl);
    return tpl;
  }
}
