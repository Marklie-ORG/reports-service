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
    return await database.em.findOne(
      Report,
      { uuid },
      { populate: ["client", "organization", "schedulingOption"] },
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

  public async updateReportData(uuid: string, providers: ScheduledProviderConfig[]) {
    const report = (await database.em.findOne(Report, { uuid })) as Report;

    if (!report) {
      throw new Error(`Report ${uuid} not found`);
    }

    const reportData: ReportData = (report.data || []) as ReportData;

    const providerConfigByName = new Map<string, ScheduledProviderConfig>();
    for (const provider of providers) {
      providerConfigByName.set(provider.provider, provider);
    }

    const getOrder = (value: number | undefined): number =>
      value === undefined || value === null ? Number.MAX_SAFE_INTEGER : value;

    const sortByOrder = <T extends { order: number }>(arr: T[]) => {
      arr.sort((a, b) => getOrder(a.order) - getOrder(b.order));
    };

    const buildMetricOrderMap = (metrics: { name: string; order: number }[]) => {
      const map = new Map<string, number>();
      for (const m of metrics) map.set(m.name, m.order);
      return map;
    };

    for (const providerReport of reportData) {
      const scheduledProvider = providerConfigByName.get(providerReport.provider);
      if (!scheduledProvider) continue;

      // Build quick access map for section config by name
      const sectionConfigByName = new Map(
        scheduledProvider.sections.map((s) => [s.name, s]),
      );

      for (const section of providerReport.sections) {
        const sectionConfig = sectionConfigByName.get(section.name);
        if (!sectionConfig) continue;

        // Apply section order
        section.order = sectionConfig.order ?? section.order;

        // Build ad account config map for this section
        const adAccountConfigById = new Map(
          sectionConfig.adAccounts.map((a) => [a.adAccountId, a]),
        );

        for (const adAccount of section.adAccounts) {
          const adAccConfig = adAccountConfigById.get(adAccount.adAccountId);
          if (!adAccConfig) continue;

          // Apply ad account order
          adAccount.order = adAccConfig.order ?? adAccount.order;

          // Apply ad account enabled state if present in request
          const enabledFromRequest = (adAccConfig as any).enabled;
          if (typeof enabledFromRequest === 'boolean') {
            (adAccount as any).enabled = enabledFromRequest;
          }

          // Apply metrics order inside ad account data based on section name
          const metricOrderMap = buildMetricOrderMap([
            ...(adAccConfig.metrics || []),
            ...((adAccConfig.customMetrics || []).map(cm => ({ name: cm.name, order: cm.order })))
          ]);

          // Build set of enabled metric names from provider config (standard + custom)
          const enabledMetricNames = new Set<string>([
            ...((adAccConfig.metrics || []).map(m => m.name)),
            ...((adAccConfig.customMetrics || []).map(cm => cm.name)),
          ]);

          if (section.name === "kpis") {
            const data = adAccount.data as KpiAdAccountData;
            for (const metric of data) {
              const ord = metricOrderMap.get(metric.name);
              if (ord !== undefined) metric.order = ord;
              (metric as any).enabled = enabledMetricNames.has(metric.name);
            }
            sortByOrder(data);
          } else if (section.name === "graphs") {
            const data = adAccount.data as GraphsAdAccountData;
            for (const graph of data) {
              for (const point of graph.data) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                (point as any).enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(graph.data);
            }
          } else if (section.name === "ads") {
            const data = adAccount.data as AdsAdAccountData;
            for (const creative of data) {
              for (const point of creative.data) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                (point as any).enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(creative.data);
            }
          } else if (section.name === "campaigns") {
            const data = adAccount.data as TableAdAccountData;
            for (const row of data) {
              for (const point of row.data) {
                const ord = metricOrderMap.get(point.name);
                if (ord !== undefined) point.order = ord;
                (point as any).enabled = enabledMetricNames.has(point.name);
              }
              sortByOrder(row.data);
            }
          }
        }

        // After updating each ad account, sort ad accounts by order
        sortByOrder(section.adAccounts);
      }

      // After updating all sections, sort sections by order
      sortByOrder(providerReport.sections);
    }

    report.data = reportData as unknown as Record<string, any>;

    await database.em.persistAndFlush(report);
  }
  
}

export type ReportData = ProviderReportResponse[]

  export interface ProviderReportResponse {
    provider: string
    sections: SectionReportResponse[]
  }

  export interface SectionReportResponse {
    name: SectionKey
    order: number
    adAccounts: AdAccountReportResponse[]
  }

  export interface AdAccountReportResponse {
    adAccountId: string
    adAccountName: string
    data: AdAccountData
    order: number
  }

  export type AdAccountData = KpiAdAccountData | GraphsAdAccountData | AdsAdAccountData | TableAdAccountData

  // kpis
  export type KpiAdAccountData = KpiAdAccountMetric[]

  export interface KpiAdAccountMetric {
    name: string
    order: number
    value: number
    enabled?: boolean
  }

  // graphs
  export type GraphsAdAccountData = GraphData[]

  export interface GraphData {
    data: GraphDataPoint[]
    date_start: string
    date_end: string
  }

  export interface GraphDataPoint {
    name: string
    order: number
    value: number
    enabled?: boolean
  }

  // ads
  export type AdsAdAccountData = AdsAdAccountDataCreative[]

  export interface AdsAdAccountDataCreative {
    adId: string
    data: AdsAdAccountDataPoint[]
    ad_name: string
    sourceUrl: string
    adCreativeId: string
    thumbnailUrl?: string
  }

  export interface AdsAdAccountDataPoint {
    name: string
    order: number
    value: number
    enabled?: boolean
  }

  // campaigns
  export type TableAdAccountData = CampaignData[]

  export interface CampaignData {
    data: CampaignDataPoint[]
    index: number
    campaign_name: string
  }

  export interface CampaignDataPoint {
    name: string
    order: number
    value: number
    enabled?: boolean
  }

  export type SectionKey = 'kpis' | 'graphs' | 'ads' | 'campaigns';