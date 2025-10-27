import { FacebookMetricProcessor } from "./FacebookMetricProcessor.js";
import { CustomFormulaProcessor } from "./CustomFormulaProcessor.js";
import type {
  CustomFormula,
  CustomMetricConfig,
  MetricConfig,
  ProviderConfig,
  SectionConfig,
  SectionType,
} from "marklie-ts-core";
import type {
  AdAccountData,
  AdData,
  CampaignData,
  GraphData,
  KpiData,
  ReportData,
  SectionData,
} from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

export class FacebookReportBuilder {
  constructor() {}

  private toNum = (v: unknown): number => {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") {
      return Number(v.replace?.("%", "") ?? v);
    }
    return 0;
  };

  /**
   * Build report data from API responses
   */
  async buildReport(
    providerConfig: ProviderConfig,
    apiDataMap: Map<string, any>,
    accountDetails: Map<string, { name: string; currency: string }>,
  ): Promise<ReportData> {
    const sections: SectionData[] = [];

    for (const sectionConfig of providerConfig.sections) {
      if (!sectionConfig.enabled) continue;

      const section = await this.buildSection(
        sectionConfig,
        apiDataMap,
        accountDetails,
      );
      sections.push(section);
    }

    return {
      provider: providerConfig.provider,
      sections: sections.sort((a, b) => a.order - b.order),
    };
  }

  private async buildSection(
    config: SectionConfig,
    apiDataMap: Map<string, any>,
    accountDetails: Map<string, { name: string; currency: string }>,
  ): Promise<SectionData> {
    const adAccounts: AdAccountData[] = [];

    for (const accountConfig of config.adAccounts) {
      if (!accountConfig.enabled) continue;

      const apiData = apiDataMap.get(accountConfig.adAccountId);
      const details = accountDetails.get(accountConfig.adAccountId);

      if (!apiData || !details) {
        adAccounts.push({
          adAccountId: accountConfig.adAccountId,
          adAccountName:
            accountConfig.adAccountName || details?.name || "Unknown",
          currency: accountConfig.currency || details?.currency || "€",
          order: accountConfig.order,
          enabled: true,
          data: this.createEmptyData(config.name),
        });
        continue;
      }

      const data = await this.processAccountData(
        config.name,
        apiData,
        accountConfig,
      );

      adAccounts.push({
        adAccountId: accountConfig.adAccountId,
        adAccountName: details.name,
        currency: details.currency,
        order: accountConfig.order,
        enabled: true,
        data,
      });
    }

    return {
      key: config.name,
      order: config.order,
      enabled: true,
      adAccounts: adAccounts.sort((a, b) => a.order - b.order),
    };
  }

  private async processAccountData(
    sectionType: SectionType,
    apiData: any,
    accountConfig: any,
  ): Promise<any[]> {
    const {
      metrics,
      customMetrics,
      customFormulas,
      adsSettings,
      campaignsSettings,
    } = accountConfig;

    switch (sectionType) {
      case "kpis":
        return await this.processKpis(
          apiData.accountInsights || [],
          metrics,
          customMetrics,
          customFormulas,
        );

      case "graphs":
        return await this.processGraphs(
          apiData.timeSeriesInsights || [],
          metrics,
          customMetrics,
          customFormulas,
        );

      case "campaigns":
        return await this.processCampaigns(
          apiData.campaignInsights || [],
          metrics,
          customMetrics,
          customFormulas,
          campaignsSettings,
        );

      case "ads":
        return await this.processAds(
          apiData.adInsights || [],
          metrics,
          customMetrics,
          customFormulas,
          adsSettings,
        );

      default:
        return [];
    }
  }

  private async processKpis(
    insights: any[],
    metrics: MetricConfig[],
    customMetrics?: CustomMetricConfig[],
    customFormulas?: CustomFormula[],
  ): Promise<KpiData[]> {
    if (!insights.length) {
      return metrics.map((m) => ({
        name: m.name,
        value: 0,
        order: m.order,
        enabled: m.enabled !== false,
      }));
    }

    // Aggregate all insights
    const agg = this.aggregateInsights(insights);
    const base = FacebookMetricProcessor.extractBaseValues(agg);
    const calc = FacebookMetricProcessor.calculateDerivedMetrics(base);
    const { byName: customByName, byId: customById } =
      FacebookMetricProcessor.extractCustomMetrics(agg, customMetrics || []);

    // Formulas
    let formulaVals: Record<string, number> = {};
    if (customFormulas?.length) {
      const ext =
        await CustomFormulaProcessor.getExtendedCustomFormulas(customFormulas);
      formulaVals = CustomFormulaProcessor.processCustomFormulas(
        ext,
        calc,
        customById, // pass ID-keyed custom values
      );
    }

    const allMetrics = [...metrics, ...(customMetrics || [])];

    return FacebookMetricProcessor.toMetricValues(
      calc,
      allMetrics,
      customByName, // show name-keyed customs
      formulaVals,
      customFormulas,
    );
  }

  private async processGraphs(
    insights: any[],
    metrics: MetricConfig[],
    customMetrics?: CustomMetricConfig[],
    customFormulas?: CustomFormula[],
  ): Promise<GraphData[]> {
    // Get extended formulas once
    let extendedFormulas: Awaited<
      ReturnType<typeof CustomFormulaProcessor.getExtendedCustomFormulas>
    > = [];
    if (customFormulas?.length) {
      extendedFormulas =
        await CustomFormulaProcessor.getExtendedCustomFormulas(customFormulas);
    }

    const allMetrics = [...metrics, ...(customMetrics || [])];

    return insights.map((insight) => {
      const baseValues = FacebookMetricProcessor.extractBaseValues(insight);
      const calculated =
        FacebookMetricProcessor.calculateDerivedMetrics(baseValues);
      const { byName: customByName, byId: customById } =
        FacebookMetricProcessor.extractCustomMetrics(
          insight,
          customMetrics || [],
        );

      let customFormulaValues: Record<string, number> = {};
      if (extendedFormulas.length > 0) {
        customFormulaValues = CustomFormulaProcessor.processCustomFormulas(
          extendedFormulas,
          calculated,
          customById,
        );
      }

      return {
        date_start: insight.date_start,
        date_stop: insight.date_stop,
        metrics: FacebookMetricProcessor.toMetricValues(
          calculated,
          allMetrics,
          customByName,
          customFormulaValues,
          customFormulas,
        ),
      };
    });
  }

  private async processCampaigns(
    insights: any[],
    metrics: MetricConfig[],
    customMetrics?: CustomMetricConfig[],
    customFormulas?: CustomFormula[],
    settings?: any,
  ): Promise<CampaignData[]> {
    let extendedFormulas: Awaited<
      ReturnType<typeof CustomFormulaProcessor.getExtendedCustomFormulas>
    > = [];
    if (customFormulas?.length) {
      extendedFormulas =
        await CustomFormulaProcessor.getExtendedCustomFormulas(customFormulas);
    }

    const allMetrics = [...metrics, ...(customMetrics || [])];

    const campaigns = insights.map((insight) => {
      const baseValues = FacebookMetricProcessor.extractBaseValues(insight);
      const calculated =
        FacebookMetricProcessor.calculateDerivedMetrics(baseValues);
      const { byName: customByName, byId: customById } =
        FacebookMetricProcessor.extractCustomMetrics(
          insight,
          customMetrics || [],
        );

      let customFormulaValues: Record<string, number> = {};
      if (extendedFormulas.length > 0) {
        customFormulaValues = CustomFormulaProcessor.processCustomFormulas(
          extendedFormulas,
          calculated,
          customById,
        );
      }

      return {
        campaignId: insight.campaign_id,
        campaignName: insight.campaign_name || "Unnamed Campaign",
        metrics: FacebookMetricProcessor.toMetricValues(
          calculated,
          allMetrics,
          customByName,
          customFormulaValues,
          customFormulas,
        ),
      };
    });

    // Sort and limit
    if (settings?.sortBy) {
      campaigns.sort((a, b) => {
        const aVal =
          a.metrics.find((m) => m.name === settings.sortBy)?.value || 0;
        const bVal =
          b.metrics.find((m) => m.name === settings.sortBy)?.value || 0;
        return bVal - aVal;
      });
    }

    const limit = settings?.maxCampaigns || 15;
    return campaigns.slice(0, limit);
  }

  private async processAds(
    insights: any[],
    metrics: MetricConfig[],
    customMetrics?: CustomMetricConfig[],
    customFormulas?: CustomFormula[],
    settings?: any,
  ): Promise<AdData[]> {
    let extendedFormulas: Awaited<
      ReturnType<typeof CustomFormulaProcessor.getExtendedCustomFormulas>
    > = [];
    if (customFormulas?.length) {
      extendedFormulas =
        await CustomFormulaProcessor.getExtendedCustomFormulas(customFormulas);
    }

    const allMetrics = [...metrics, ...(customMetrics || [])];

    insights = this.aggregateAdsByAdName(insights);

    const ads = insights.map((insight) => {
      const baseValues = FacebookMetricProcessor.extractBaseValues(insight);
      const calculated =
        FacebookMetricProcessor.calculateDerivedMetrics(baseValues);
      const { byName: customByName, byId: customById } =
        FacebookMetricProcessor.extractCustomMetrics(
          insight,
          customMetrics || [],
        );

      let customFormulaValues: Record<string, number> = {};
      if (extendedFormulas.length > 0) {
        customFormulaValues = CustomFormulaProcessor.processCustomFormulas(
          extendedFormulas,
          calculated,
          customById,
        );
      }

      return {
        adId: insight.ad_id,
        adName: insight.ad_name || " Ad",
        adCreativeId: insight.creative?.id || "",
        thumbnailUrl: insight.creative?.thumbnail_url || "",
        sourceUrl: insight.creative?.instagram_permalink_url || "",
        metrics: FacebookMetricProcessor.toMetricValues(
          calculated,
          allMetrics,
          customByName,
          customFormulaValues,
          customFormulas,
        ),
      };
    });

    return this.getBestAds(ads, settings?.sortBy, settings?.maxAds ?? 10);
  }

  private getBestAds(
    ads: {
      metrics: Array<{ id?: string; name: string; value: number | string }>;
    }[],
    metric: string = "spend",
    limit: number = 10,
    dir: "asc" | "desc" = "desc",
  ): any[] {
    const key = metric.toLowerCase();

    const toNumber = (v: unknown): number => {
      if (typeof v === "number") return Number.isFinite(v) ? v : 0;
      if (typeof v === "string") {
        const n = parseFloat(v.replace("%", ""));
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    };

    const getMetricValue = (ad: any): number => {
      const m = ad.metrics?.find(
        (x: any) =>
          x?.name?.toLowerCase() === key || x?.id?.toLowerCase() === key,
      );
      return toNumber(m?.value);
    };

    const mult = dir === "asc" ? 1 : -1;

    return ads
      .slice()
      .sort((a, b) => mult * (getMetricValue(a) - getMetricValue(b)))
      .slice(0, limit);
  }

  private aggregateAdsByAdName(adsInsights: any[]): any[] {
    const map = new Map<string, any>();
    const numericLike = (v: any) =>
      typeof v === "number" ||
      (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));

    for (const row of adsInsights) {
      const key = row.ad_name || "Unnamed Ad";
      const acc = map.get(key) ?? { ...row };
      if (!map.has(key)) {
        map.set(key, acc);
        continue;
      }

      // sum numeric fields
      for (const [k, v] of Object.entries(row)) {
        if (
          k === "ad_id" ||
          k === "adId" ||
          k === "ad_name" ||
          k === "creative"
        )
          continue;
        if (numericLike(v)) acc[k] = this.toNum(acc[k]) + this.toNum(v);
      }

      // merge actions
      if (Array.isArray(row.actions)) {
        const m = new Map<string, number>();
        for (const a of acc.actions ?? [])
          m.set(a.action_type, this.toNum(a.value));
        for (const a of row.actions)
          m.set(
            a.action_type,
            (m.get(a.action_type) ?? 0) + this.toNum(a.value),
          );
        acc.actions = [...m].map(([action_type, value]) => ({
          action_type,
          value: String(value),
        }));
      }

      // merge action_values
      if (Array.isArray(row.action_values)) {
        const m = new Map<string, number>();
        for (const a of acc.action_values ?? [])
          m.set(a.action_type, this.toNum(a.value));
        for (const a of row.action_values)
          m.set(
            a.action_type,
            (m.get(a.action_type) ?? 0) + this.toNum(a.value),
          );
        acc.action_values = [...m].map(([action_type, value]) => ({
          action_type,
          value: String(value),
        }));
      }
    }

    return [...map.values()];
  }

  private aggregateInsights(insights: any[]): any {
    const aggregated: any = {
      actions: [],
      action_values: [],
    };

    // Sum numeric fields
    for (const insight of insights) {
      for (const [key, value] of Object.entries(insight)) {
        if (
          typeof value === "number" ||
          (typeof value === "string" && !isNaN(Number(value)))
        ) {
          aggregated[key] = (aggregated[key] || 0) + Number(value);
        }
      }
    }

    // Aggregate actions
    const actionMap = new Map<string, number>();
    const actionValueMap = new Map<string, number>();

    for (const insight of insights) {
      if (insight.actions) {
        for (const action of insight.actions) {
          const key = action.action_type;
          actionMap.set(
            key,
            (actionMap.get(key) || 0) + Number(action.value || 0),
          );
        }
      }

      if (insight.action_values) {
        for (const action of insight.action_values) {
          const key = action.action_type;
          actionValueMap.set(
            key,
            (actionValueMap.get(key) || 0) + Number(action.value || 0),
          );
        }
      }
    }

    aggregated.actions = Array.from(actionMap).map(([action_type, value]) => ({
      action_type,
      value: String(value),
    }));

    aggregated.action_values = Array.from(actionValueMap).map(
      ([action_type, value]) => ({
        action_type,
        value: String(value),
      }),
    );

    return aggregated;
  }

  private createEmptyData(sectionType: SectionType): any[] {
    switch (sectionType) {
      case "kpis":
        return [];
      case "graphs":
        return [
          {
            date_start: new Date().toISOString().split("T")[0],
            date_stop: new Date().toISOString().split("T")[0],
            metrics: [],
          },
        ];
      case "campaigns":
      case "ads":
        return [];
      default:
        return [];
    }
  }
}
