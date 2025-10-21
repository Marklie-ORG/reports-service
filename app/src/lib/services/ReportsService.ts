import { ReportsUtil } from "../utils/ReportsUtil.js";
import {
  ActivityLog,
  Database,
  GCSWrapper,
  Log,
  type ProviderConfig,
  PubSubWrapper,
  Report,
} from "marklie-ts-core";
import { Temporal } from "@js-temporal/polyfill";
import { ReportsConfigService } from "../config/config.js";
import { ReportQueueService } from "./ReportsQueueService.js";
import type { ReportImages } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("reports-service");
const config = ReportsConfigService.getInstance();

type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K] | undefined;
};

export class ReportsService {
  async getReport(uuid: string): Promise<Report | null> {
    const report = await database.em.findOne(
      Report,
      { uuid },
      { populate: ["client", "organization"] },
    );
    if (!report) return null;

    const gcs = GCSWrapper.getInstance(config.get("GCS_REPORTS_BUCKET"));

    const logos = report.customization?.logos;
    if (logos) {
      if (logos.org?.gcsUri) {
        logos.org.url = await gcs.getSignedUrl(logos.org.gcsUri);
      } else if (logos.org) {
        logos.org.url = "";
      }
      if (logos.client?.gcsUri) {
        logos.client.url = await gcs.getSignedUrl(logos.client.gcsUri);
      } else if (logos.client) {
        logos.client.url = "";
      }
    }

    return report;
  }

  async getReports(organizationUuid: string | undefined): Promise<Report[]> {
    if (!organizationUuid) throw new Error("No organization Uuid");
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
      { orderBy: { createdAt: "DESC" }, populate: ["client"] },
    );
  }

  async sendReportAfterReview(uuid: string, sendAt?: string) {
    const report = await database.em.findOne(
      Report,
      { uuid },
      { populate: ["client", "organization"] },
    );
    if (!report) throw new Error(`Report ${uuid} not found`);

    const tz = report.schedule?.timezone || "UTC";

    logger.info("generating report");
    const pdfBuffer = await ReportsUtil.generateReportPdf(uuid);
    logger.info("report generated");

    const filePath = ReportsUtil.generateFilePath(
      report.client.uuid,
      report.schedule!.datePreset,
    );

    const gcs = GCSWrapper.getInstance(config.get("GCS_REPORTS_BUCKET"));
    report.storage.pdfGcsUri = await gcs.uploadBuffer(
      pdfBuffer,
      filePath,
      "application/pdf",
      false,
      false,
    );

    report.review.reviewedAt = new Date();
    await database.em.flush();

    const payload = {
      clientUuid: report.client.uuid,
      organizationUuid: report.organization.uuid,
      reportUuid: report.uuid,
      messages: report.messaging,
      reportUrl: report.storage.pdfGcsUri,
    };

    if (sendAt) {
      const plain = Temporal.PlainDateTime.from(sendAt);
      const zoned = plain.toZonedDateTime(tz);
      const delayMs =
        zoned.epochMilliseconds - Temporal.Now.instant().epochMilliseconds;

      if (delayMs > 0) {
        logger.info(
          `Delaying report delivery to ${zoned.toString()} (${delayMs}ms)`,
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

  async getPendingReviewCount(
    organizationUuid: string | undefined,
  ): Promise<number> {
    if (!organizationUuid) {
      throw new Error("No organization Uuid");
    }

    return database.em.count(Report, {
      organization: organizationUuid,
      review_required: true,
      review_reviewed_at: null,
    } as any);
  }

  async updateReportImages(uuid: string, images: ReportImages) {
    const report = await database.em.findOne(Report, { uuid });
    if (!report) throw new Error(`Report ${uuid} not found`);

    const gcs = GCSWrapper.getInstance(config.get("GCS_REPORTS_BUCKET"));
    report.customization ??= {
      title: "",
      colors: { headerBg: "#fff", reportBg: "#fff" },
      logos: {},
    };

    const logos = report.customization.logos ?? {};
    const orgGcs = images.organizationLogo ?? logos.org?.gcsUri ?? "";
    const cliGcs = images.clientLogo ?? logos.client?.gcsUri ?? "";

    report.customization.logos = {
      org: {
        gcsUri: orgGcs,
        url: orgGcs ? await gcs.getSignedUrl(orgGcs) : "",
      },
      client: {
        gcsUri: cliGcs,
        url: cliGcs ? await gcs.getSignedUrl(cliGcs) : "",
      },
    };

    await database.em.persistAndFlush(report);
  }

  async updateReportMetadata(
    uuid: string,
    patch: Partial<Record<string, any>>,
  ): Promise<Report> {
    const em = database.em.fork({ clear: true });

    return em.transactional(async (tem) => {
      const report = await tem.findOne(Report, { uuid });
      if (!report) throw new Error(`Report ${uuid} not found`);

      for (const [k, vRaw] of Object.entries(patch)) {
        switch (k) {
          case "review": {
            const base = report.review ?? {
              required: false,
              reviewedAt: undefined,
              loomUrl: undefined,
            };
            report.review = this.deepMerge(
              base,
              vRaw as PartialDeep<typeof base>,
            );
            break;
          }
          case "storage": {
            const base = report.storage ?? { pdfGcsUri: "" };
            report.storage = this.deepMerge(
              base,
              vRaw as PartialDeep<typeof base>,
            );
            break;
          }
          case "schedule": {
            const v = this.normalizeSchedulePatch(vRaw);
            const base = report.schedule ?? {
              schedulingOptionUuid: "",
              timezone: "",
              lastRun: new Date(),
              nextRun: new Date(),
              jobId: "",
              datePreset: "",
            };
            report.schedule = this.deepMerge(
              base,
              v as PartialDeep<typeof base>,
            );
            break;
          }
          case "customization": {
            const base = report.customization ?? {
              colors: { headerBg: "#ffffff", reportBg: "#ffffff" },
              logos: {},
              title: "Report",
            };
            report.customization = this.deepMerge(
              base,
              vRaw as PartialDeep<typeof base>,
            );
            break;
          }
          case "messaging": {
            const base = report.messaging ?? {
              pdfFilename: report.customization?.title ?? "report.pdf",
            };
            report.messaging = this.deepMerge(
              base,
              vRaw as PartialDeep<typeof base>,
            );
            break;
          }
          case "data": {
            report.data = vRaw as any;
            break;
          }
          case "extras": {
            const base = report.extras ?? {};
            report.extras = this.deepMerge(
              base,
              vRaw as PartialDeep<typeof base>,
            );
            break;
          }
          case "type": {
            report.type = String(vRaw);
            break;
          }
          default:
            break;
        }
      }

      await tem.persistAndFlush(report);
      return tem.findOneOrFail(Report, { uuid }, { refresh: true });
    });
  }

  private normalizeSchedulePatch(p: any) {
    if (!p || typeof p !== "object") return p;
    const out: any = { ...p };
    if ("schedulingOptionId" in out && !("schedulingOptionUuid" in out)) {
      out.schedulingOptionUuid = out.schedulingOptionId;
      delete out.schedulingOptionId;
    }
    if ("timeZone" in out && !("timezone" in out)) {
      out.timezone = out.timeZone;
      delete out.timeZone;
    }
    return out;
  }

  private deepMerge<T extends object>(target: T, patch: PartialDeep<T>): T {
    for (const [k, v] of Object.entries(patch as object)) {
      const key = k as keyof T;
      const tv = (target as any)[key];
      if (this.isPlainObject(tv) && this.isPlainObject(v)) {
        (target as any)[key] = this.deepMerge(
          { ...(tv as object) },
          v as object,
        );
      } else if (v !== undefined) {
        (target as any)[key] = v;
      }
    }
    return target;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  }

  public async updateReportData(uuid: string, providers: ProviderConfig[]) {
    const report = await database.em.findOne(Report, { uuid });
    if (!report) throw new Error(`Report ${uuid} not found`);

    const reportData = (report.data as Record<string, any>[]) ?? [];

    const providerConfigByName = new Map<string, ProviderConfig>();
    for (const provider of providers)
      providerConfigByName.set(provider.provider, provider);

    const getOrder = (v?: number) =>
      v === undefined || v === null ? Number.MAX_SAFE_INTEGER : v;
    const sortByOrder = <T extends { order: number }>(arr: T[]) =>
      arr.sort((a, b) => getOrder(a.order) - getOrder(b.order));
    const buildMetricOrderMap = (
      metrics: { name: string; order: number }[],
    ) => {
      const map = new Map<string, number>();
      for (const m of metrics) map.set(m.name, m.order);
      return map;
    };

    for (const providerReport of reportData) {
      const scheduledProvider = providerConfigByName.get(
        providerReport.provider,
      );
      if (!scheduledProvider) continue;

      const sectionConfigByName = new Map(
        scheduledProvider.sections.map((s) => [s.name, s]),
      );

      for (const section of providerReport.sections ?? []) {
        const sectionConfig = sectionConfigByName.get(section.name);
        if (!sectionConfig) continue;

        section.order = sectionConfig.order ?? section.order;
        section.enabled = sectionConfig.enabled;

        const adAccountConfigById = new Map(
          sectionConfig.adAccounts.map((a) => [a.adAccountId, a]),
        );

        for (const adAccount of section.adAccounts ?? []) {
          const adAccConfig = adAccountConfigById.get(adAccount.adAccountId);
          if (!adAccConfig) continue;

          adAccount.order = adAccConfig.order ?? adAccount.order;
          adAccount.enabled = adAccConfig.enabled;

          const metricOrderMap = buildMetricOrderMap([
            ...(adAccConfig.metrics || []),
            ...(adAccConfig.customMetrics || []).map((cm) => ({
              name: cm.name,
              order: cm.order,
            })),
          ]);
          const enabledMetricNames = new Set<string>([
            ...(adAccConfig.metrics || []).map((m) => m.name),
            ...(adAccConfig.customMetrics || []).map((cm) => cm.name),
          ]);

          if (section.name === "kpis") {
            const data = adAccount.data ?? [];
            for (const metric of data) {
              const ord = metricOrderMap.get(metric.name);
              if (ord !== undefined) metric.order = ord;
              metric.enabled = enabledMetricNames.has(metric.name);
            }
            sortByOrder(data);
          } else if (section.name === "graphs") {
            const data = adAccount.data ?? [];
            for (const graph of data) {
              for (const point of graph.data ?? []) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                point.enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(graph.data ?? []);
            }
          } else if (section.name === "ads") {
            const data = adAccount.data ?? [];
            for (const creative of data) {
              for (const point of creative.data ?? []) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                point.enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(creative.data ?? []);
            }
          } else if (section.name === "campaigns") {
            const data = adAccount.data ?? [];
            for (const row of data) {
              for (const point of row.data ?? []) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                point.enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(row.data ?? []);
            }
          }
        }
        sortByOrder(section.adAccounts ?? []);
      }
      sortByOrder(providerReport.sections ?? []);
    }

    report.data = reportData;
    await database.em.persistAndFlush(report);
  }
}
