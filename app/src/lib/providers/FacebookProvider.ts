import { FacebookApi } from "../apis/FacebookApi.js";
import { type AdsProvider } from "./AdsProvider.js";
import {
  ClientAdAccount,
  Database,
  type ReportDataAd,
  type ReportDataCampaign,
  type ReportDataGraph,
  type ReportDataSection,
  type ReportDataSectionAdAccount,
} from "marklie-ts-core";
import { FacebookDataUtil } from "../utils/FacebookDataUtil.js";
import pLimit from "p-limit";
import type {
  AvailableAdMetric,
  AvailableCampaignMetric,
  AvailableGraphMetric,
  AvailableKpiMetric,
  Metric,
  ScheduledAdAccountConfig,
  ScheduledMetricGroup,
  SectionConfig,
} from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

const database = await Database.getInstance();

export class FacebookProvider implements AdsProvider {
  readonly providerName = "facebook";
  private api: FacebookApi | undefined;

  async authenticate(
    organizationUuid: string,
    accountId?: string,
  ): Promise<void> {
    this.api = await FacebookApi.create(organizationUuid, accountId);
  }

  async getProviderData(
    sections: SectionConfig[],
    clientUuid: string,
    organizationUuid: string,
    datePreset: string,
  ): Promise<ReportDataSection[]> {
    const linkedAccounts = await database.em.find(ClientAdAccount, {
      client: clientUuid,
    });
    const scheduledConfigs = convertSectionsToScheduledConfigs(sections);

    const groupedConfigs = new Map();

    for (const config of scheduledConfigs) {
      const existing = groupedConfigs.get(config.adAccountId);
      if (!existing) {
        groupedConfigs.set(config.adAccountId, config);
      } else {
        existing.kpis.metrics.push(...config.kpis.metrics);
        existing.graphs.metrics.push(...config.graphs.metrics);
        existing.ads.metrics.push(...config.ads.metrics);
        existing.campaigns.metrics.push(...config.campaigns.metrics);

        existing.kpis.customMetrics?.push(...(config.kpis.customMetrics || []));
        existing.graphs.customMetrics?.push(
          ...(config.graphs.customMetrics || []),
        );
        existing.ads.customMetrics?.push(...(config.ads.customMetrics || []));
        existing.campaigns.customMetrics?.push(
          ...(config.campaigns.customMetrics || []),
        );
      }
    }

    const limit = pLimit(5);
    const dataMap = new Map();

    await Promise.all(
      Array.from(groupedConfigs.values()).map((config) =>
        limit(async () => {
          const linked = linkedAccounts.find(
            (acc) => acc.adAccountId === config.adAccountId,
          );

          if (!linked) {
            console.log(
              `Ad account ${config.adAccountId} not linked. Skipping...`,
            );
            return;
          }

          const reportData = await FacebookDataUtil.getAdAccountReportData(
            organizationUuid,
            config.adAccountId,
            datePreset,
            config,
          );

          dataMap.set(config.adAccountId, {
            adAccountId: config.adAccountId,
            adAccountName: linked.adAccountName,
            kpis: reportData.kpis,
            graphs: reportData.graphs,
            ads: reportData.ads,
            campaigns: reportData.campaigns,
          });
        }),
      ),
    );

    return sections
      .filter((section) => section.enabled)
      .map((section): ReportDataSection => {
        const adAccounts: ReportDataSectionAdAccount[] = section.adAccounts.map(
          (adAccount: {
            adAccountId: string;
            order: any;
            currency: string;
          }) => {
            const runtime = dataMap.get(adAccount.adAccountId);
            const linked = linkedAccounts.find(
              (acc) => acc.adAccountId === adAccount.adAccountId,
            );

            if (!runtime) {
              // Fallback: create empty data with requested metrics set to 0
              const config = groupedConfigs.get(adAccount.adAccountId);
              let fallbackData:
                | Metric[]
                | ReportDataAd[]
                | ReportDataCampaign[]
                | ReportDataGraph[] = [];

              if (config) {
                switch (section.name) {
                  case "kpis":
                    const selectedKpis =
                      FacebookDataUtil.extractOrderedMetricNames(config.kpis);
                    const kpisCustomMetrics = config.kpis.customMetrics || [];

                    // Combine regular metrics and custom metrics
                    const kpisMetrics = selectedKpis.map((name, index) => ({
                      name,
                      order: index,
                      value: 0,
                    }));

                    const kpisCustom = kpisCustomMetrics.map(
                      (cm: { name: any; order: any }) => ({
                        name: cm.name,
                        order: cm.order,
                        value: 0,
                      }),
                    );

                    fallbackData = [...kpisMetrics, ...kpisCustom].sort(
                      (a, b) => a.order - b.order,
                    );
                    break;

                  case "graphs":
                    const selectedGraphs =
                      FacebookDataUtil.extractOrderedMetricNames(config.graphs);
                    const graphsCustomMetrics =
                      config.graphs.customMetrics || [];

                    // Combine regular metrics and custom metrics for graphs
                    const graphsMetrics = selectedGraphs.map((name, index) => ({
                      name,
                      order: index,
                      value: 0,
                    }));

                    const graphsCustom = graphsCustomMetrics.map(
                      (cm: { name: any; order: any }) => ({
                        name: cm.name,
                        order: cm.order,
                        value: 0,
                      }),
                    );

                    fallbackData = [
                      {
                        data: [...graphsMetrics, ...graphsCustom].sort(
                          (a, b) => a.order - b.order,
                        ),
                        date_start: new Date().toISOString().split("T")[0],
                        date_stop: new Date().toISOString().split("T")[0],
                      },
                    ];
                    break;

                  case "ads":
                    // For ads, return empty array as there are no ads to show
                    fallbackData = [];
                    break;

                  case "campaigns":
                    // For campaigns, return empty array as there are no campaigns to show
                    fallbackData = [];
                    break;

                  default:
                    fallbackData = [];
                }
              }

              return {
                adAccountId: adAccount.adAccountId,
                adAccountName:
                  linked?.adAccountName ||
                  `Ad Account ${adAccount.adAccountId}`,
                order: adAccount.order || 0,
                data: fallbackData,
                currency: adAccount.currency,
              };
            }

            let data:
              | Metric[]
              | ReportDataAd[]
              | ReportDataCampaign[]
              | ReportDataGraph[] = [];

            switch (section.name) {
              case "kpis":
                data = runtime.kpis ?? [];
                break;
              case "graphs":
                data = runtime.graphs ?? [];
                break;
              case "ads":
                data = runtime.ads ?? [];
                break;
              case "campaigns":
                data = runtime.campaigns ?? [];
                break;
              default:
                data = [];
            }

            return {
              adAccountId: adAccount.adAccountId,
              adAccountName: runtime.adAccountName,
              order: adAccount.order || 0,
              data,
              currency: adAccount.currency,
            };
          },
        );

        return {
          name: section.name,
          order: section.order || 0,
          adAccounts,
        };
      });
  }

  protected convertToRuntimeMetrics(
    rawData: Record<string, number | null>,
    metricNames: string[],
  ): { name: string; value: number | null }[] {
    return metricNames.map((name) => ({
      name,
      value: rawData?.[name] ?? null,
    }));
  }

  async getCustomMetrics(
    accountIds: string[],
  ): Promise<Record<string, { id: string; name: string }[]>> {
    return this.api!.getCustomConversionsForAdAccounts(accountIds);
  }
}

export function convertSectionsToScheduledConfigs(
  sections: SectionConfig[],
): ScheduledAdAccountConfig[] {
  const map = new Map<string, ScheduledAdAccountConfig>();
  const adAccountOrder: string[] = [];

  for (const section of sections) {
    if (!section.enabled) {
      continue;
    }
    for (const account of section.adAccounts) {
      if (!account.enabled) {
        continue;
      }
      const adAccountId = account.adAccountId;

      if (!map.has(adAccountId)) {
        adAccountOrder.push(adAccountId);
        map.set(adAccountId, {
          adAccountId,
          kpis: emptyGroup(),
          graphs: emptyGroup(),
          ads: emptyGroup(),
          campaigns: emptyGroup(),
        });
      }

      const group = {
        order: account.order,
        metrics: account.metrics,
        customMetrics: account.customMetrics ?? undefined,
        adsSettings: account.adsSettings ?? undefined,
      };

      const existing = map.get(adAccountId)!;

      switch (section.name) {
        case "kpis":
          existing.kpis = group as ScheduledMetricGroup<AvailableKpiMetric>;
          break;
        case "graphs":
          existing.graphs = group as ScheduledMetricGroup<AvailableGraphMetric>;
          break;
        case "ads":
          existing.ads = group as ScheduledMetricGroup<AvailableAdMetric>;
          break;
        case "campaigns":
          existing.campaigns =
            group as ScheduledMetricGroup<AvailableCampaignMetric>;
          break;
      }
    }
  }

  return adAccountOrder.map((id) => map.get(id)!);
}

function emptyGroup(): ScheduledMetricGroup<any> {
  return { order: 0, metrics: [] };
}
