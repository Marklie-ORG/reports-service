import { FacebookApi } from "../apis/FacebookApi.js";
import { type AdsProvider, type SectionConfig } from "./AdsProvider.js";
import {
  ClientAdAccount,
  Database,
  type RuntimeAdAccountData,
} from "marklie-ts-core";
import {
  convertSectionsToScheduledConfigs,
  FacebookDataUtil,
} from "../utils/FacebookDataUtil.js";
import pLimit from "p-limit";
import type { ScheduledAdAccountConfig } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

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
  ): Promise<SectionConfig[]> {
    const linkedAccounts = await database.em.find(ClientAdAccount, {
      client: clientUuid,
    });

    const scheduledConfigs = convertSectionsToScheduledConfigs(sections);

    const groupedConfigs = new Map<string, ScheduledAdAccountConfig>();

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
    const dataMap = new Map<string, RuntimeAdAccountData>();

    await Promise.all(
      Array.from(groupedConfigs.values()).map((config) =>
        limit(async () => {
          const linked = linkedAccounts.find(
            (acc) => acc.adAccountId === config.adAccountId,
          );
          if (!linked) return;

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

    return sections.map((section) => {
      const updatedAdAccounts = section.adAccounts.map((adAccount) => {
        const runtime = dataMap.get(adAccount.adAccountId);
        if (!runtime) return adAccount;

        let metrics: any = [];
        switch (section.name) {
          case "kpis":
            metrics = runtime.kpis ?? [];
            break;
          case "graphs":
            metrics = runtime.graphs ?? [];
            break;
          case "ads":
            metrics = runtime.ads ?? [];
            break;
          case "campaigns":
            metrics = runtime.campaigns ?? [];
            break;
        }

        return {
          ...adAccount,
          adAccountName: runtime.adAccountName,
          metrics,
        };
      });

      return {
        ...section,
        adAccounts: updatedAdAccounts,
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
    return this.api!.getCustomMetricsForAdAccounts(accountIds);
  }
}
