import type { AdsProvider } from "../AdsProvider.js";
import { FacebookApi } from "../../apis/FacebookApi.js";
import { FacebookDataFetcher } from "./FacebookDataFetcher.js";
import { FacebookReportBuilder } from "./FacebookReportBuilder.js";
import {
  type AdAccountConfig,
  ClientAdAccount,
  Database,
  Log,
  type ProviderConfig,
  type SectionConfig,
} from "marklie-ts-core";
import type { SectionData } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("facebook-provider");

export class FacebookProvider implements AdsProvider {
  readonly providerName = "facebook";
  private api: FacebookApi | undefined;
  private fetcher: FacebookDataFetcher | undefined;
  private builder: FacebookReportBuilder | undefined;

  async authenticate(
    organizationUuid: string,
    accountId?: string,
  ): Promise<void> {
    this.api = await FacebookApi.create(organizationUuid, accountId);
    this.fetcher = new FacebookDataFetcher(this.api, logger);
    this.builder = new FacebookReportBuilder();
  }

  async getProviderData(
    sections: SectionConfig[],
    clientUuid: string,
    datePreset: string,
  ): Promise<SectionData[]> {
    if (!this.api || !this.fetcher || !this.builder) {
      throw new Error("Provider not authenticated");
    }

    // Get linked accounts
    const linkedAccounts = await database.em.find(ClientAdAccount, {
      client: clientUuid,
      provider: this.providerName,
    });

    const accountDetailsMap = new Map(
      linkedAccounts.map((acc) => [
        acc.adAccountId,
        { name: acc.adAccountName, currency: "€" }, // TODO: Get currency from API
      ]),
    );

    // Group sections by account to optimize API calls
    const accountConfigs = this.groupByAccount(sections);
    const sectionTypes = [...new Set(sections.map((s) => s.name))];

    // Fetch data for all accounts
    const apiDataMap = await this.fetcher.fetchMultipleAccounts(
      accountConfigs,
      datePreset,
      sectionTypes,
    );

    // Build report
    const providerConfig: ProviderConfig = {
      provider: this.providerName,
      sections,
    };

    const report = await this.builder.buildReport(
      providerConfig,
      apiDataMap,
      accountDetailsMap,
    );

    return report.sections;
  }

  private groupByAccount(sections: SectionConfig[]): AdAccountConfig[] {
    const accountMap = new Map<string, AdAccountConfig>();

    for (const section of sections) {
      if (!section.enabled) continue;

      for (const account of section.adAccounts) {
        if (!account.enabled) continue;

        const existing = accountMap.get(account.adAccountId);
        if (!existing) {
          accountMap.set(account.adAccountId, {
            ...account,
            metrics: [...account.metrics],
            customMetrics: [...(account.customMetrics || [])],
          });
        } else {
          // Merge metrics
          const metricSet = new Set(existing.metrics.map((m) => m.name));
          for (const metric of account.metrics) {
            if (!metricSet.has(metric.name)) {
              existing.metrics.push(metric);
            }
          }

          // Merge custom metrics
          const customSet = new Set(
            (existing.customMetrics || []).map((m) => m.id),
          );
          for (const custom of account.customMetrics || []) {
            if (!customSet.has(custom.id)) {
              existing.customMetrics = existing.customMetrics || [];
              existing.customMetrics.push(custom);
            }
          }
        }
      }
    }

    return Array.from(accountMap.values());
  }

  async getCustomMetrics(
    accountIds: string[],
  ): Promise<Record<string, { id: string; name: string }[]>> {
    if (!this.api) throw new Error("Provider not authenticated");
    return this.api.getCustomConversionsForAdAccounts(accountIds);
  }
}
