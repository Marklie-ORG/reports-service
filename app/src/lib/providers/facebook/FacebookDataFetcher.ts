import { FacebookApi } from "../../apis/FacebookApi.js";
import pLimit from "p-limit";
import type { AdAccountConfig, Log, SectionType } from "marklie-ts-core";
import { FACEBOOK_BASE_METRICS } from "./FacebookMetricProcessor.js";
import { CustomFormulaProcessor } from "./CustomFormulaProcessor.js";

// function dedupeNames(names: string[]): string[] {
//   const s = new Set<string>();
//   for (const n of names) if (n) s.add(n);
//   return [...s];
// }

export class FacebookDataFetcher {
  constructor(
    private api: FacebookApi,
    private logger: Log,
  ) {}

  /**
   * Fetch data for multiple ad accounts with concurrency control
   */
  async fetchMultipleAccounts(
    configs: AdAccountConfig[],
    datePreset: string,
    sections: SectionType[],
  ): Promise<Map<string, any>> {
    const limit = pLimit(3);
    const results = new Map<string, any>();

    await Promise.all(
      configs.map((config) =>
        limit(async () => {
          try {
            const api = await FacebookApi.create(
              this.api.getOrganizationUuid(),
              config.adAccountId,
            );
            const data = await this.fetchAccountDataWithApi(
              api,
              config,
              datePreset,
              sections,
            );
            results.set(config.adAccountId, data);
          } catch (error) {
            this.logger.error(
              `Failed to fetch data for ${config.adAccountId}:`,
              error,
            );
            results.set(config.adAccountId, null);
          }
        }),
      ),
    );

    return results;
  }

  private async fetchAccountDataWithApi(
    api: FacebookApi,
    config: AdAccountConfig,
    datePreset: string,
    sections: SectionType[],
  ): Promise<any> {
    const data: any = {};

    const extFormulas = await CustomFormulaProcessor.getExtendedCustomFormulas(
      config.customFormulas ?? [],
    );
    const { defaultMetrics: formulaBaseMetrics, customMetricIds } =
      CustomFormulaProcessor.getRequiredMetrics(extFormulas);

    const needsAccountLevel = sections.some(
      (s) => s === "kpis" || s === "graphs",
    );
    const needsCampaigns = sections.includes("campaigns");
    const needsAds = sections.includes("ads");

    const hasCustom =
      (config.customMetrics?.length ?? 0) > 0 || customMetricIds.length > 0;

    const mergedMetricNames = [
      ...new Set([...config.metrics.map((m) => m.name), ...formulaBaseMetrics]),
    ];
    const fields = this.getRequiredFieldsByNames(mergedMetricNames, hasCustom);

    if (needsAccountLevel) {
      if (sections.includes("kpis")) {
        data.accountInsights = await api.getInsightsSmart("account", fields, {
          datePreset,
        });
      }
      if (sections.includes("graphs")) {
        data.timeSeriesInsights = await api.getInsightsSmart(
          "account",
          fields,
          {
            datePreset,
            timeIncrement: this.calculateTimeIncrement(datePreset),
          },
        );
      }
    }

    if (needsCampaigns) {
      data.campaignInsights = await api.getInsightsSmart(
        "campaign",
        [...fields, "campaign_name", "campaign_id"],
        { datePreset },
      );
    }

    if (needsAds) {
      data.adInsights = await api.getAdInsightsWithThumbnails(
        [...fields, "ad_name"],
        datePreset,
      );
    }

    return data;
  }

  /**
   * Fetch data for a single ad account
   */
  // private async fetchAccountData(
  //   config: AdAccountConfig,
  //   datePreset: string,
  //   sections: SectionType[],
  // ): Promise<any> {
  //   const data: any = {};
  //   this.api.setAccountId(config.adAccountId);
  //
  //   // derive extra requirements from custom formulas
  //   const extFormulas = await CustomFormulaProcessor.getExtendedCustomFormulas(
  //     config.customFormulas ?? [],
  //   );
  //   const { defaultMetrics: formulaBaseMetrics, customMetricIds } =
  //     CustomFormulaProcessor.getRequiredMetrics(extFormulas);
  //
  //   const needsAccountLevel = sections.some(
  //     (s) => s === "kpis" || s === "graphs",
  //   );
  //   const needsCampaigns = sections.includes("campaigns");
  //   const needsAds = sections.includes("ads");
  //
  //   const hasCustom =
  //     (config.customMetrics?.length ?? 0) > 0 || customMetricIds.length > 0;
  //
  //   // merge selected + formula-required base metrics (names only)
  //   const mergedMetricNames = dedupeNames([
  //     ...config.metrics.map((m) => m.name),
  //     ...formulaBaseMetrics,
  //   ]);
  //
  //   if (needsAccountLevel) {
  //     const fields = this.getRequiredFieldsByNames(
  //       mergedMetricNames,
  //       hasCustom,
  //     );
  //     if (sections.includes("kpis")) {
  //       data.accountInsights = await this.api.getInsightsSmart(
  //         "account",
  //         fields,
  //         { datePreset },
  //       );
  //     }
  //     if (sections.includes("graphs")) {
  //       data.timeSeriesInsights = await this.api.getInsightsSmart(
  //         "account",
  //         fields,
  //         {
  //           datePreset,
  //           timeIncrement: this.calculateTimeIncrement(datePreset),
  //         },
  //       );
  //     }
  //   }
  //
  //   if (needsCampaigns) {
  //     const fields = this.getRequiredFieldsByNames(
  //       mergedMetricNames,
  //       hasCustom,
  //     );
  //     data.campaignInsights = await this.api.getInsightsSmart(
  //       "campaign",
  //       [...fields, "campaign_name", "campaign_id"],
  //       { datePreset },
  //     );
  //   }
  //
  //   if (needsAds) {
  //     const fields = this.getRequiredFieldsByNames(
  //       mergedMetricNames,
  //       hasCustom,
  //     );
  //     data.adInsights = await this.api.getAdInsightsWithThumbnails(
  //       [...fields, "ad_name"],
  //       datePreset,
  //     );
  //   }
  //
  //   // Note: you will compute formula values later and only include the formula
  //   // metric in the rendered output. The extra base metrics are fetch-only.
  //   return data;
  // }

  private getRequiredFieldsByNames(
    metricNames: string[],
    hasCustom: boolean,
  ): string[] {
    const fields = new Set<string>();
    for (const name of metricNames) {
      const def =
        FACEBOOK_BASE_METRICS[name as keyof typeof FACEBOOK_BASE_METRICS];
      if (!def) continue;

      if ("fields" in def) for (const f of def.fields) fields.add(f);

      if ("dependencies" in def) {
        for (const dep of def.dependencies ?? []) {
          const d =
            FACEBOOK_BASE_METRICS[dep as keyof typeof FACEBOOK_BASE_METRICS];
          if (d && "fields" in d) for (const f of d.fields) fields.add(f);
        }
      }
    }
    if (hasCustom) {
      fields.add("actions");
      fields.add("action_values");
    }
    return [...fields];
  }

  /**
   * Get required API fields for selected metrics
   */
  // private getRequiredFields(
  //   metrics: MetricConfig[],
  //   hasCustom: boolean,
  // ): string[] {
  //   const fields = new Set<string>();
  //
  //   for (const metric of metrics) {
  //     const config =
  //       FACEBOOK_BASE_METRICS[
  //         metric.name as keyof typeof FACEBOOK_BASE_METRICS
  //       ];
  //     if (config && "fields" in config) {
  //       config.fields.forEach((f) => fields.add(f));
  //     }
  //
  //     // Add dependencies
  //     if (config && "dependencies" in config) {
  //       for (const dep of config.dependencies) {
  //         const depConfig =
  //           FACEBOOK_BASE_METRICS[dep as keyof typeof FACEBOOK_BASE_METRICS];
  //         if (depConfig && "fields" in depConfig) {
  //           depConfig.fields.forEach((f) => fields.add(f));
  //         }
  //       }
  //     }
  //   }
  //
  //   if (hasCustom) {
  //     fields.add("actions");
  //     fields.add("action_values");
  //   }
  //
  //   return Array.from(fields);
  // }

  private calculateTimeIncrement(datePreset: string): number {
    // Calculate appropriate time increment based on date range
    const dayMap: Record<string, number> = {
      today: 1,
      yesterday: 1,
      last_3d: 1,
      last_7d: 1,
      last_14d: 2,
      last_28d: 4,
      last_30d: 4,
      last_90d: 13,
      last_month: 4,
      this_month: 4,
      last_quarter: 13,
      this_quarter: 13,
    };

    return dayMap[datePreset] || 7;
  }
}
