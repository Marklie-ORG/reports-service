import { FacebookApi } from "../apis/FacebookApi.js";
import {
  AVAILABLE_ADS_METRICS,
  AVAILABLE_CAMPAIGN_METRICS,
  AVAILABLE_GRAPH_METRICS,
  AVAILABLE_KPI_METRICS,
  type Metric,
  type ScheduledAdAccountConfig,
} from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";
import type {
  ReportDataAd,
  ReportDataCampaign,
  ReportDataGraph,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import type { CustomMetric } from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces";

export class FacebookDataUtil {
  private static resolveMetricsFromMap(
    selected: string[],
    map: Record<string, string[] | string>,
  ): string[] {
    return [...new Set(selected.flatMap((m) => map[m] ?? [m]))];
  }

  private static getActionValue(actions: any[], type: string): number {
    return Number(actions?.find((a) => a.action_type === type)?.value || 0);
  }

  private static getActionMonetaryValue(values: any[], type: string): number {
    return Number(values?.find((a) => a.action_type === type)?.value || 0);
  }

  // private static getLeads(values: any[], type: string): number {
  //   return Number(values?.find((a) => a.action_type === type)?.value || 0);
  // }

  public static async getAdAccountReportData(
    organizationUuid: string,
    adAccountId: string,
    datePreset: string,
    adAccountConfig: ScheduledAdAccountConfig,
  ): Promise<{
    kpis: Metric[];
    graphs: ReportDataGraph[];
    campaigns: ReportDataCampaign[];
    ads: ReportDataAd[];
  }> {
    const api = await FacebookApi.create(organizationUuid, adAccountId);

    const selectedKpis = this.extractOrderedMetricNames(adAccountConfig.kpis);
    const selectedAds = this.extractOrderedMetricNames(adAccountConfig.ads);
    const selectedGraphs = this.extractOrderedMetricNames(
      adAccountConfig.graphs,
    );
    const selectedCampaigns = this.extractOrderedMetricNames(
      adAccountConfig.campaigns,
    );
    const allCustomMetrics = this.combineCustomMetrics(adAccountConfig);

    const allMetrics = [
      ...this.resolveMetricsFromMap(selectedKpis, AVAILABLE_KPI_METRICS),
      ...this.resolveMetricsFromMap(selectedAds, AVAILABLE_ADS_METRICS),
      ...this.resolveMetricsFromMap(selectedGraphs, AVAILABLE_GRAPH_METRICS),
      ...this.resolveMetricsFromMap(
        [...selectedCampaigns, "campaign_name"],
        AVAILABLE_CAMPAIGN_METRICS,
      ),
    ];

    if (allCustomMetrics.length > 0) {
      allMetrics.push("actions", "action_values");
    }

    const fields = [...new Set(allMetrics)];
    const hasGraphs = selectedGraphs.length > 0;
    const insights = await api.getInsightsSmart("campaign", fields, {
      datePreset,
      additionalFields: ["campaign_id", "ad_id", "date_start", "date_stop"],
      ...(hasGraphs ? { timeIncrement: 1 } : {}),
    });

    const kpis = this.aggregateCampaignDataToKPIs(
      insights,
      selectedKpis,
      allCustomMetrics,
    );

    const graphs = this.aggregateCampaignDataToGraphs(
      insights,
      selectedGraphs,
      allCustomMetrics,
    );

    console.log(graphs);

    const campaigns = this.normalizeCampaigns(
      insights,
      selectedCampaigns,
      allCustomMetrics,
    );

    let ads: ReportDataAd[] = [];
    if (selectedAds.length > 0) {
      const adsInsights = await api.getAdInsightsWithThumbnails(
        selectedAds,
        datePreset,
      );
      ads = await this.processAds(
        adsInsights,
        selectedAds,
        organizationUuid,
        adAccountId,
      );
    }

    return {
      kpis: kpis as Metric[],
      graphs,
      campaigns,
      ads,
    };
  }

  public static extractOrderedMetricNames<
    T extends { name: string; order: number },
  >(metricGroup: {
    order: number;
    metrics: T[];
    customMetrics?: CustomMetric[];
  }): string[] {
    return metricGroup.metrics
      .sort((a, b) => a.order - b.order)
      .map((metric) => metric.name);
  }

  private static combineCustomMetrics(
    adAccountConfig: ScheduledAdAccountConfig,
  ): CustomMetric[] {
    const customMetricsMap = new Map<string, CustomMetric>();

    [
      adAccountConfig.kpis,
      adAccountConfig.graphs,
      adAccountConfig.ads,
      adAccountConfig.campaigns,
    ].forEach((section) => {
      if (section.customMetrics) {
        section.customMetrics.forEach((metric) => {
          customMetricsMap.set(metric.id, metric);
        });
      }
    });

    return Array.from(customMetricsMap.values()).sort(
      (a, b) => a.order - b.order,
    );
  }

  private static aggregateCampaignDataToKPIs(
    campaignData: any[],
    selectedMetrics: string[],
    selectedCustomMetrics: CustomMetric[] = [],
  ): { name: string; value: any; order: number }[] | null {
    if (!campaignData || campaignData.length === 0) return null;

    const aggregated = {
      spend: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
      purchases: 0,
      add_to_cart: 0,
      initiated_checkouts: 0,
      conversion_value: 0,
      engagement: 0,
      leads: 0,
    };

    const customMetricMap: Record<string, number> = {};
    const selectedCustomMap = new Map(
      selectedCustomMetrics.map((m) => [m.id, m.name]),
    );

    for (const campaign of campaignData) {
      aggregated.spend += Number(campaign.spend || 0);
      aggregated.impressions += Number(campaign.impressions || 0);
      aggregated.clicks += Number(campaign.clicks || 0);
      aggregated.reach += Number(campaign.reach || 0);

      if (campaign.actions) {
        aggregated.purchases += this.getActionValue(
          campaign.actions,
          "omni_purchase",
        );
        aggregated.add_to_cart += this.getActionValue(
          campaign.actions,
          "omni_add_to_cart",
        );
        aggregated.initiated_checkouts += this.getActionValue(
          campaign.actions,
          "initiate_checkout",
        );
        aggregated.engagement +=
          this.getActionValue(campaign.actions, "post_engagement") ||
          this.getActionValue(campaign.actions, "page_engagement");
        aggregated.leads += this.getActionValue(campaign.actions, "lead");

        for (const action of campaign.actions) {
          const match = action.action_type?.match(
            /^offsite_conversion\.custom\.(\d+)$/,
          );
          if (match) {
            const id = match[1];
            const name = selectedCustomMap.get(id);
            if (name) {
              customMetricMap[name] =
                (customMetricMap[name] ?? 0) + Number(action.value ?? 0);
            }
          }
        }
      }

      if (campaign.action_values) {
        aggregated.conversion_value += this.getActionMonetaryValue(
          campaign.action_values,
          "omni_purchase",
        );
      }
    }

    const metrics: Record<string, any> = {
      ...aggregated,
      cpc: aggregated.clicks > 0 ? aggregated.spend / aggregated.clicks : 0,
      ctr:
        aggregated.impressions > 0
          ? (aggregated.clicks / aggregated.impressions) * 100
          : 0,
      cpm:
        aggregated.impressions > 0
          ? (aggregated.spend / aggregated.impressions) * 1000
          : 0,
      cpp:
        aggregated.reach > 0 ? (aggregated.spend / aggregated.reach) * 1000 : 0,
      purchase_roas:
        aggregated.spend > 0
          ? aggregated.conversion_value / aggregated.spend
          : 0,
      cost_per_purchase:
        aggregated.purchases > 0 ? aggregated.spend / aggregated.purchases : 0,
      cost_per_add_to_cart:
        aggregated.add_to_cart > 0
          ? aggregated.spend / aggregated.add_to_cart
          : 0,
      cost_per_lead:
        aggregated.leads > 0 ? aggregated.spend / aggregated.leads : 0,
      conversion_rate:
        aggregated.clicks > 0
          ? (aggregated.purchases / aggregated.clicks) * 100
          : 0,
      ...customMetricMap,
    };

    for (const cm of selectedCustomMetrics) {
      if (!(cm.name in metrics)) {
        metrics[cm.name] = 0;
      }
    }

    const normalize = (s: string) => s.trim().toLowerCase();
    const allowedKeys = new Set([
      ...selectedMetrics.map(normalize),
      ...selectedCustomMetrics.map((m) => normalize(m.name)),
    ]);

    const metricOrderMap = new Map<string, number>();
    selectedMetrics.forEach((name, index) => {
      metricOrderMap.set(name.trim().toLowerCase(), index);
    });
    selectedCustomMetrics.forEach((cm) => {
      metricOrderMap.set(cm.name.trim().toLowerCase(), cm.order);
    });

    return Object.entries(metrics)
      .filter(([key]) => allowedKeys.has(normalize(key)))
      .map(([name, value]) => ({
        name,
        value,
        order: metricOrderMap.get(normalize(name)) ?? 999,
      }))
      .sort((a, b) => a.order - b.order);
  }

  private static aggregateCampaignDataToGraphs(
    insights: any[],
    selectedGraphs: string[],
    allCustomMetrics: CustomMetric[],
  ): ReportDataGraph[] {
    if (!insights || insights.length === 0) return [];

    const dateGroups = new Map<string, any[]>();

    // Group insights by date
    for (const dataPoint of insights) {
      const date = dataPoint.date_start;
      if (!dateGroups.has(date)) {
        dateGroups.set(date, []);
      }
      dateGroups.get(date)!.push(dataPoint);
    }

    const graphs: ReportDataGraph[] = [];

    for (const [date, dayData] of dateGroups) {
      // Aggregate all campaigns for this date
      const aggregatedInsight: any = {
        date_start: date,
        date_stop: dayData[0]?.date_stop || date,
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        actions: [],
        action_values: [],
      };

      // Sum up numeric fields
      for (const campaign of dayData) {
        for (const [key, value] of Object.entries(campaign)) {
          if (
            typeof value === "number" ||
            (typeof value === "string" && !isNaN(Number(value)))
          ) {
            if (key !== "date_start" && key !== "date_stop") {
              aggregatedInsight[key] =
                (aggregatedInsight[key] || 0) + Number(value);
            }
          }
        }

        // Aggregate actions
        if (campaign.actions) {
          for (const action of campaign.actions) {
            const existing = aggregatedInsight.actions.find(
              (a: any) => a.action_type === action.action_type,
            );
            if (existing) {
              existing.value = (
                Number(existing.value) + Number(action.value)
              ).toString();
            } else {
              aggregatedInsight.actions.push({
                action_type: action.action_type,
                value: action.value,
              });
            }
          }
        }

        // Aggregate action_values
        if (campaign.action_values) {
          for (const actionValue of campaign.action_values) {
            const existing = aggregatedInsight.action_values.find(
              (a: any) => a.action_type === actionValue.action_type,
            );
            if (existing) {
              existing.value = (
                Number(existing.value) + Number(actionValue.value)
              ).toString();
            } else {
              aggregatedInsight.action_values.push({
                action_type: actionValue.action_type,
                value: actionValue.value,
              });
            }
          }
        }
      }

      graphs.push({
        data: this.extractMetricsFromInsight(
          aggregatedInsight,
          selectedGraphs,
          allCustomMetrics,
        ),
        date_start: date,
        date_stop: aggregatedInsight.date_stop,
      });
    }

    // Sort by date
    graphs.sort(
      (a, b) =>
        new Date(a.date_start).getTime() - new Date(b.date_start).getTime(),
    );

    return graphs;
  }

  private static extractMetricsFromInsight(
    insight: any,
    selectedMetrics: string[],
    customMetrics: CustomMetric[] = [],
  ): Metric[] {
    if (!insight) return [];

    const customMetricIdToName = new Map<string, string>();
    const customMetricOrderMap = new Map<string, number>();

    customMetrics.forEach((cm) => {
      customMetricIdToName.set(cm.id, cm.name);
      customMetricOrderMap.set(cm.name, cm.order);
    });

    const spend = Number(insight.spend || 0);
    const impressions = Number(insight.impressions || 0);
    const clicks = Number(insight.clicks || 0);
    const reach = Number(insight.reach || 0);

    const purchases = this.getActionValue(insight.actions, "omni_purchase");
    const add_to_cart = this.getActionValue(
      insight.actions,
      "omni_add_to_cart",
    );
    const initiated_checkouts = this.getActionValue(
      insight.actions,
      "initiate_checkout",
    );
    const leads = this.getActionValue(insight.actions, "lead");
    const engagement =
      this.getActionValue(insight.actions, "post_engagement") ||
      this.getActionValue(insight.actions, "page_engagement");

    const conversion_value = this.getActionMonetaryValue(
      insight.action_values,
      "omni_purchase",
    );

    const metricsMap: Record<string, any> = {
      spend,
      impressions,
      clicks,
      reach,
      purchases,
      add_to_cart,
      initiated_checkouts,
      leads,
      engagement,
      conversion_value,
      cpc: clicks > 0 ? spend / clicks : 0,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
      cpp: reach > 0 ? (spend / reach) * 1000 : 0,
      purchase_roas: spend > 0 ? conversion_value / spend : 0,
      cost_per_purchase: purchases > 0 ? spend / purchases : 0,
      cost_per_add_to_cart: add_to_cart > 0 ? spend / add_to_cart : 0,
      cost_per_lead: leads > 0 ? spend / leads : 0,
      conversion_rate: clicks > 0 ? (purchases / clicks) * 100 : 0,
    };

    if (insight.actions) {
      for (const action of insight.actions) {
        const match = action.action_type?.match(
          /^offsite_conversion\.custom\.(\d+)$/,
        );
        if (match) {
          const id = match[1];
          const name = customMetricIdToName.get(id);
          if (name) {
            metricsMap[name] =
              (metricsMap[name] ?? 0) + Number(action.value || 0);
          }
        }
      }
    }

    for (const cm of customMetrics) {
      if (!(cm.name in metricsMap)) {
        metricsMap[cm.name] = 0;
      }
    }

    const normalizeKey = (key: string) => key.toLowerCase();
    const allowedMetrics = new Set([
      ...selectedMetrics.map(normalizeKey),
      ...customMetrics.map((cm) => normalizeKey(cm.name)),
    ]);

    const metricOrderMap = new Map<string, number>();
    selectedMetrics.forEach((name, index) => {
      metricOrderMap.set(normalizeKey(name), index);
    });
    customMetrics.forEach((cm) => {
      metricOrderMap.set(normalizeKey(cm.name), cm.order);
    });

    return Object.entries(metricsMap)
      .filter(([key]) => allowedMetrics.has(normalizeKey(key)))
      .map(([name, value]) => ({
        name,
        value,
        order: metricOrderMap.get(normalizeKey(name)) ?? 999,
      }))
      .sort((a, b) => a.order - b.order);
  }

  private static normalizeCampaigns(
    insights: any[],
    selectedCampaigns: string[],
    allCustomMetrics: CustomMetric[],
  ): ReportDataCampaign[] {
    const topCampaigns = this.getTopCampaigns(insights, 15);

    return topCampaigns.map((campaign, index) => ({
      index,
      campaign_name: campaign.campaign_name || `Campaign ${index + 1}`,
      data: this.extractMetricsFromInsight(
        campaign,
        selectedCampaigns.filter((m) => m !== "campaign_name"),
        allCustomMetrics,
      ),
    }));
  }

  private static getTopCampaigns(campaigns: any[], limit: number = 10): any[] {
    if (!campaigns || campaigns.length === 0) {
      return [];
    }

    // Define priority metrics for campaign filtering (in order of preference)
    const metricPriority = [
      "spend", // Most important - shows budget allocation
      "impressions", // Shows reach and visibility
      "clicks", // Shows engagement
      "purchases", // Shows conversions
      "conversion_value", // Shows revenue
      "reach", // Shows unique reach
      "add_to_cart", // Shows interest
    ];

    let sortMetric = "spend"; // Default to spend
    let filteredCampaigns: any[] = [];

    for (const metric of metricPriority) {
      filteredCampaigns = campaigns.filter((campaign) => {
        const value = Number(campaign[metric] || 0);
        return value > 0;
      });

      if (filteredCampaigns.length > 0) {
        sortMetric = metric;
        console.log(
          `Filtering campaigns by ${sortMetric} - found ${filteredCampaigns.length} campaigns with data`,
        );
        break;
      }
    }

    if (filteredCampaigns.length === 0) {
      console.log(
        "No campaigns found with priority metrics, returning all campaigns",
      );
      filteredCampaigns = campaigns;
      sortMetric = "spend"; // Keep default for sorting
    }

    const sortedCampaigns = filteredCampaigns.sort((a, b) => {
      const valueA = Number(a[sortMetric] || 0);
      const valueB = Number(b[sortMetric] || 0);
      return valueB - valueA; // Descending order (highest first)
    });

    // Apply the limit
    const topCampaigns = sortedCampaigns.slice(0, limit);
    return topCampaigns;
  }

  private static getBest10AdsByROAS(ads: any[], metric: string): any[] {
    return ads
      .filter((ad) => ad[metric])
      .sort((a, b) => parseFloat(b[metric]) - parseFloat(a[metric]))
      .slice(0, 10);
  }

  private static async processAds(
    adsInsights: any[],
    selectedAds: string[],
    organizationUuid: string,
    adAccountId: string,
  ): Promise<ReportDataAd[]> {
    const shownAds = this.getBest10AdsByROAS(adsInsights, "impressions");
    const api = await FacebookApi.create(organizationUuid, adAccountId);

    const reportAds: ReportDataAd[] = shownAds.map((ad) => ({
      adId: ad.adId || ad.ad_id,
      adCreativeId: ad.adCreativeId || "",
      thumbnailUrl: ad.thumbnailUrl || "",
      sourceUrl: ad.sourceUrl || "",
      ad_name: ad.ad_name || "",
      data: this.extractMetricsFromInsight(ad, selectedAds, []),
    }));

    // --- Enrich with Creative IDs ---
    const adIds = shownAds.map((a) => a.adId || a.ad_id);
    const adEntities = await api.getEntitiesBatch(adIds, [
      "id",
      "creative{id}",
    ]);

    const creativeIds = adEntities
      .map((ad: any) => ad.creative?.id)
      .filter(Boolean);

    const creativeAssets = await api.getEntitiesBatch(creativeIds, [
      "id",
      "effective_instagram_media_id",
      "effective_object_story_id",
      "thumbnail_url",
      "instagram_permalink_url",
    ]);

    // Assign creativeId to ads
    reportAds.forEach((ad) => {
      const adEntity = adEntities.find((e: any) => e.id === ad.adId);
      ad.adCreativeId = adEntity?.creative?.id || "";
    });

    // --- Fetch thumbnail & sourceUrl ---
    await Promise.all(
      reportAds.map(async (ad) => {
        const asset = creativeAssets.find((c: any) => c.id === ad.adCreativeId);
        if (!asset) return;

        if (asset.effective_instagram_media_id) {
          const igMedia = await api.getInstagramMedia(
            asset.effective_instagram_media_id,
          );
          ad.thumbnailUrl =
            igMedia.media_type === "IMAGE" && !igMedia.thumbnail_url
              ? igMedia.media_url
              : igMedia.thumbnail_url;
          ad.sourceUrl = igMedia.permalink;
        } else if (asset.effective_object_story_id) {
          const postId = asset.effective_object_story_id.split("_")[1];
          const post = await api.getPost(postId);
          ad.thumbnailUrl =
            post.adcreatives?.data?.[0]?.thumbnail_url ||
            asset.thumbnail_url ||
            "";
          ad.sourceUrl =
            post.permalink_url || asset.instagram_permalink_url || "";
        } else {
          ad.thumbnailUrl = asset.thumbnail_url || "";
        }
      }),
    );

    return reportAds;
  }
}
