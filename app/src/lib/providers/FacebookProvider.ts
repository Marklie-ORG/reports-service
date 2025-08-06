import { FacebookApi } from "../apis/FacebookApi.js";
import type { RuntimeAdAccountData } from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import type { AdsProvider } from "./AdsProvider.js";
import { type ScheduledAdAccountConfig, type SchedulingOptionMetrics } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";
import { ClientAdAccount, Database, Log } from "marklie-ts-core";
import { FacebookDataUtil } from "../utils/FacebookDataUtil.js";

const database = await Database.getInstance();
const logger: Log = Log.getInstance().extend("facebook-provider");

export class FacebookProvider implements AdsProvider {
  readonly providerName = "facebook";
  private api: FacebookApi | undefined;

  async authenticate(
    organizationUuid: string,
    accountId?: string,
  ): Promise<void> {
    this.api = await FacebookApi.create(organizationUuid, accountId);
  }

  public async getProviderData(
    adAccountsConfig: ScheduledAdAccountConfig[],
    clientUuid: string,
    organizationUuid: string,
    datePreset: string,
  ): Promise<RuntimeAdAccountData[]> {
    const linkedAccounts = await database.em.find(ClientAdAccount, {
      client: clientUuid,
    });

    const results: RuntimeAdAccountData[] = [];

    for (const linked of linkedAccounts) {
      const config = adAccountsConfig.find(
        (a) => a.adAccountId === linked.adAccountId,
      );
      if (!config) continue;

      const rawReportData = await FacebookDataUtil.getAllReportData(
        organizationUuid,
        linked.adAccountId,
        datePreset,
        config as SchedulingOptionMetrics,
      );

      results.push({
        adAccountId: linked.adAccountId,
        adAccountName: linked.adAccountName,
        kpis: rawReportData.kpis!,
        graphs: rawReportData.graphs,
        ads: rawReportData.ads,
        campaigns: rawReportData.campaigns,
      });
    }

    logger.info(`Fetched data for ${results.length} Facebook ad account(s).`);
    return results;
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
