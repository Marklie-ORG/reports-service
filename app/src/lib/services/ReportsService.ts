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
import type { ScheduledProviderConfig } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("reports-service");
const config = ReportsConfigService.getInstance();

export class ReportsService {
  async getReport(uuid: string): Promise<Report | null> {
    const report = await database.em.findOne(
      Report,
      { uuid },
      { populate: ["client", "organization", "schedulingOption"] },
    );
    const gcs = GCSWrapper.getInstance("marklie-client-reports");

    if (report?.metadata) {
      report.metadata.images.organizationLogo = report.metadata.images
        .organizationLogoGsUri
        ? await gcs.getSignedUrl(report.metadata.images.organizationLogoGsUri)
        : "";
      report.metadata.images.clientLogo = report.metadata.images.clientLogoGsUri
        ? await gcs.getSignedUrl(report.metadata.images.clientLogoGsUri)
        : "";
    }

    return report;
  }

  async getReports(organizationUuid: string | undefined): Promise<Report[]> {
    if (!organizationUuid) {
      throw new Error("No organization Uuid");
    }
    // @ts-ignore
    return await database.em.find(
      Report,
      {
        organization: organizationUuid,
      },
      {
        populate: ["client"],
        fields: [
          "uuid",
          "reportType",
          "reviewRequired",
          "client.uuid",
          "client.name",
        ],
      },
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
      reportUrl: report.gcsUrl,
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

  async getPendingReviewCount(
    organizationUuid: string | undefined,
  ): Promise<number> {
    if (!organizationUuid) {
      throw new Error("No organization Uuid");
    }

    return await database.em.count(Report, {
      organization: organizationUuid,
      reviewRequired: true,
      reviewedAt: null,
    });
  }

  async updateReportImages(uuid: string, images: ReportImages) {
    const report = await database.em.findOne(Report, { uuid });

    if (!report) {
      throw new Error(`Report ${uuid} not found`);
    }

    const gcs = GCSWrapper.getInstance("marklie-client-reports");

    report.metadata!.images = {
      organizationLogo: images.organizationLogo
        ? await gcs.getSignedUrl(images.organizationLogo)
        : "",
      clientLogo: images.clientLogo
        ? await gcs.getSignedUrl(images.clientLogo)
        : "",
      organizationLogoGsUri: images.organizationLogo,
      clientLogoGsUri: images.clientLogo,
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

      const current: Record<string, any> = (report.metadata ?? {}) as Record<
        string,
        any
      >;
      report.metadata = this.deepMerge({ ...current }, patch);
      await tem.persistAndFlush(report);

      return tem.findOneOrFail(Report, { uuid }, { refresh: true });
    });
  }

  private deepMerge<T extends object>(target: T, patch: Partial<T>): T {
    for (const [k, v] of Object.entries(patch)) {
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

  isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  }

  public async updateReportData(
    uuid: string,
    providers: ScheduledProviderConfig[],
  ) {
    const report = (await database.em.findOne(Report, { uuid })) as Report;

    if (!report) {
      throw new Error(`Report ${uuid} not found`);
    }

    const reportData = report.data as Record<string, any>[];

    const providerConfigByName = new Map<string, ScheduledProviderConfig>();
    for (const provider of providers) {
      providerConfigByName.set(provider.provider, provider);
    }

    const getOrder = (value: number | undefined): number =>
      value === undefined || value === null ? Number.MAX_SAFE_INTEGER : value;

    const sortByOrder = <T extends { order: number }>(arr: T[]) => {
      arr.sort((a, b) => getOrder(a.order) - getOrder(b.order));
    };

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

      for (const section of providerReport.sections) {
        const sectionConfig = sectionConfigByName.get(section.name);
        if (!sectionConfig) continue;

        section.order = sectionConfig.order ?? section.order;

        section.enabled = sectionConfig.enabled;

        const adAccountConfigById = new Map(
          sectionConfig.adAccounts.map((a) => [a.adAccountId, a]),
        );

        for (const adAccount of section.adAccounts) {
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
            const data = adAccount.data;
            for (const metric of data) {
              const ord = metricOrderMap.get(metric.name);
              if (ord !== undefined) metric.order = ord;
              metric.enabled = enabledMetricNames.has(metric.name);
            }
            sortByOrder(data);
          } else if (section.name === "graphs") {
            const data = adAccount.data;
            for (const graph of data) {
              for (const point of graph.data) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                point.enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(graph.data);
            }
          } else if (section.name === "ads") {
            const data = adAccount.data;
            for (const creative of data) {
              for (const point of creative.data) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                point.enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(creative.data);
            }
          } else if (section.name === "campaigns") {
            const data = adAccount.data;
            for (const row of data) {
              for (const point of row.data) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                point.enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(row.data);
            }
          }
        }
        sortByOrder(section.adAccounts);
      }
      sortByOrder(providerReport.sections);
    }

    report.data = reportData;

    await database.em.persistAndFlush(report);
  }
}
