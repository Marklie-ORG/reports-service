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

  public static async getAdAccountReportData(
    organizationUuid: string,
    adAccountId: string,
    datePreset: string,
    adAccountConfig: ScheduledAdAccountConfig,
  ): Promise<
    Partial<{
      kpis: Metric[];
      graphs: ReportDataGraph[];
      campaigns: ReportDataCampaign[];
      ads: ReportDataAd[];
    }>
  > {
    const api = await FacebookApi.create(organizationUuid, adAccountId);

    const selectedKpis = this.extractOrderedMetricNames(adAccountConfig.kpis);
    const selectedGraphs = this.extractOrderedMetricNames(
      adAccountConfig.graphs,
    );
    const selectedCampaigns = this.extractOrderedMetricNames(
      adAccountConfig.campaigns,
    );
    const selectedAds = this.extractOrderedMetricNames(adAccountConfig.ads);

    const kpisCustom = adAccountConfig.kpis.customMetrics ?? [];
    const graphsCustom = adAccountConfig.graphs.customMetrics ?? [];
    const campaignsCustom = adAccountConfig.campaigns.customMetrics ?? [];

    const result: Partial<{
      kpis: any;
      graphs: ReportDataGraph[];
      campaigns: ReportDataCampaign[];
      ads: ReportDataAd[];
    }> = {};

    const fieldsAggregate: string[] = [
      ...(selectedKpis.length
        ? this.resolveMetricsFromMap(selectedKpis, AVAILABLE_KPI_METRICS)
        : []),
      ...(selectedCampaigns.length
        ? this.resolveMetricsFromMap(
            [...selectedCampaigns, "campaign_name"],
            AVAILABLE_CAMPAIGN_METRICS,
          )
        : []),
    ];

    if (kpisCustom.length && selectedKpis.length) {
      fieldsAggregate.push("actions", "action_values");
    }
    if (campaignsCustom.length && selectedCampaigns.length) {
      if (!fieldsAggregate.includes("actions")) fieldsAggregate.push("actions");
      if (!fieldsAggregate.includes("action_values"))
        fieldsAggregate.push("action_values");
    }

    const fieldsTimeSeries: string[] = [
      ...(selectedGraphs.length
        ? this.resolveMetricsFromMap(selectedGraphs, AVAILABLE_GRAPH_METRICS)
        : []),
    ];
    if (graphsCustom.length && selectedGraphs.length) {
      fieldsTimeSeries.push("actions", "action_values");
    }

    let insightsAggregate: any[] | null = null;
    if (fieldsAggregate.length) {
      insightsAggregate = await api.getInsightsSmart(
        "campaign",
        [...new Set(fieldsAggregate)],
        {
          datePreset,
          additionalFields: ["campaign_id", "ad_id", "date_start", "date_stop"],
        },
      );
    }

    let insightsTimeSeries: any[] | null = null;
    if (fieldsTimeSeries.length) {
      insightsTimeSeries = await api.getInsightsSmart(
        "campaign",
        [...new Set(fieldsTimeSeries)],
        {
          datePreset,
          additionalFields: ["campaign_id", "ad_id", "date_start", "date_stop"],
        },
      );
    }

    if (selectedKpis.length && insightsAggregate) {
      result.kpis = this.aggregateCampaignDataToKPIs(
        insightsAggregate,
        selectedKpis,
        kpisCustom,
      );
    }

    if (selectedCampaigns.length && insightsAggregate) {
      result.campaigns = this.normalizeCampaigns(
        insightsAggregate,
        selectedCampaigns,
        campaignsCustom,
      );
    }

    if (selectedGraphs.length && insightsTimeSeries) {
      result.graphs = this.aggregateCampaignDataToGraphs(
        insightsTimeSeries,
        selectedGraphs,
        graphsCustom,
        datePreset,
      );
    }

    if (selectedAds.length) {
      const resolvedAds = this.resolveMetricsFromMap(
        selectedAds,
        AVAILABLE_ADS_METRICS,
      );
      const adsInsights = await api.getAdInsightsWithThumbnails(
        resolvedAds,
        datePreset,
      );
      result.ads = await this.processAds(
        adsInsights,
        selectedAds,
        organizationUuid,
        adAccountId,
      );
    }

    return result;
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
    datePreset?: string,
  ): ReportDataGraph[] {
    if (!insights || insights.length === 0) return [];

    console.log(insights);
    const daysForPreset = (p?: string): number => {
      if (!p) return 7;
      const map: Record<string, number> = {
        last_7d: 7,
        last_14d: 14,
        last_28d: 28,
        last_30d: 30,
        last_90d: 90,
      };
      return map[p] ?? 7;
    };

    const toYMD = (d: Date) => d.toISOString().slice(0, 10);
    const addDays = (base: Date, n: number) => {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + n);
      return d;
    };

    // Group raw rows by date
    const rawByDate = new Map<string, any[]>();
    for (const row of insights) {
      const d = row.date_start;
      if (!rawByDate.has(d)) rawByDate.set(d, []);
      rawByDate.get(d)!.push(row);
    }

    // Determine continuous date span
    let endDateStr: string | null = null;
    for (const rows of rawByDate.values()) {
      for (const r of rows) {
        const ds = r.date_stop ?? r.date_start;
        if (!endDateStr || ds > endDateStr) endDateStr = ds;
      }
    }
    if (!endDateStr) endDateStr = toYMD(new Date());
    const endDate = new Date(endDateStr + "T00:00:00Z");

    const span = Math.max(1, daysForPreset(datePreset));
    const startDate = addDays(endDate, -(span - 1));

    // Build full list of dates in the span
    const fullDates: string[] = [];
    for (let i = 0; i < span; i++) fullDates.push(toYMD(addDays(startDate, i)));

    // Aggregate per-day (fill missing with zeros)
    const daily: ReportDataGraph[] = [];
    for (const date of fullDates) {
      const dayRows = rawByDate.get(date) ?? [];

      const agg: any = {
        date_start: date,
        date_stop: dayRows[0]?.date_stop || date,
        spend: 0,
        impressions: 0,
        clicks: 0,
        reach: 0,
        actions: [],
        action_values: [],
      };

      for (const c of dayRows) {
        for (const [k, v] of Object.entries(c)) {
          if (
            typeof v === "number" ||
            (typeof v === "string" && !isNaN(Number(v)))
          ) {
            if (k !== "date_start" && k !== "date_stop") {
              agg[k] = (agg[k] ?? 0) + Number(v);
            }
          }
        }

        if (c.actions) {
          for (const a of c.actions) {
            const ex = agg.actions.find(
              (x: any) => x.action_type === a.action_type,
            );
            if (ex) ex.value = (Number(ex.value) + Number(a.value)).toString();
            else
              agg.actions.push({ action_type: a.action_type, value: a.value });
          }
        }

        if (c.action_values) {
          for (const av of c.action_values) {
            const ex = agg.action_values.find(
              (x: any) => x.action_type === av.action_type,
            );
            if (ex) ex.value = (Number(ex.value) + Number(av.value)).toString();
            else
              agg.action_values.push({
                action_type: av.action_type,
                value: av.value,
              });
          }
        }
      }

      daily.push({
        data: this.extractMetricsFromInsight(
          agg,
          selectedGraphs,
          allCustomMetrics,
        ),
        date_start: date,
        date_stop: agg.date_stop,
      });
    }

    // Sample every N days where N = ceil(span / 7)
    const step = Math.max(1, Math.ceil(span / 7)); // 14 -> 2, 28 -> 4, 30 -> 5, etc.
    if (step === 1 && daily.length <= 7) return daily; // already fine

    const isAverageMetric = (name: string) =>
      /(ctr|rate|roas|cpc|cpm|cpp|cost)/i.test(name);

    const sampled: ReportDataGraph[] = [];
    for (let i = 0; i < daily.length; i += step) {
      const window = daily.slice(i, i + step);
      if (!window.length) continue;

      const byName = new Map<
        string,
        { sum: number; count: number; order?: number }
      >();
      for (const day of window) {
        for (const m of day.data) {
          const key = m.name;
          const cur = byName.get(key) ?? {
            sum: 0,
            count: 0,
            order: (m as any).order,
          };
          cur.sum += Number(m.value ?? 0);
          cur.count += 1;
          if (cur.order === undefined && (m as any).order !== undefined)
            cur.order = (m as any).order;
          byName.set(key, cur);
        }
      }

      const aggregatedMetrics: Metric[] = Array.from(byName.entries())
        .map(([name, acc]) => {
          const value = isAverageMetric(name) ? acc.sum / acc.count : acc.sum;
          return { name, order: acc.order ?? 0, value };
        })
        .sort((a, b) => a.order - b.order);

      sampled.push({
        data: aggregatedMetrics,
        date_start: window[0].date_start, // <-- first day in the bucket
        date_stop: window[window.length - 1].date_stop, // <-- last day in the bucket
      });
    }

    // Ensure at most 7 points (sampling may produce 8 if span not divisible by step)
    return sampled.slice(-7);
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

    reportAds.forEach((ad) => {
      const adEntity = adEntities.find((e: any) => e.id === ad.adId);
      ad.adCreativeId = adEntity?.creative?.id || "";
    });

    await Promise.all(
      reportAds.map(async (reportAd) => {
        const creativeAsset = creativeAssets.find(
          (c: { id: string }) => c.id === reportAd.adCreativeId,
        );
        if (!creativeAsset) return;

        const {
          effective_instagram_media_id,
          effective_object_story_id,
          thumbnail_url,
          instagram_permalink_url,
        } = creativeAsset;

        if (effective_instagram_media_id) {
          const igMedia = await api.getInstagramMedia(
            effective_instagram_media_id,
          );

          if (igMedia.media_type === "CAROUSEL_ALBUM") {
            const children = await api.getInstagramCarouselChildren(
              effective_instagram_media_id,
            );

            const firstChild = children?.data?.[0];
            if (firstChild) {
              const childMedia = await api.getInstagramMedia(firstChild.id);
              reportAd.thumbnailUrl =
                childMedia.media_type === "IMAGE" && !childMedia.thumbnail_url
                  ? childMedia.media_url
                  : childMedia.thumbnail_url;
              reportAd.sourceUrl = childMedia.permalink || igMedia.permalink;
            }
          } else {
            reportAd.thumbnailUrl =
              igMedia.media_type === "IMAGE" && !igMedia.thumbnail_url
                ? igMedia.media_url
                : igMedia.thumbnail_url;
            reportAd.sourceUrl = igMedia.permalink;
          }
        } else if (effective_object_story_id) {
          const postId = effective_object_story_id.split("_")[1];
          const post = await api.getPost(postId);
          reportAd.thumbnailUrl =
            post.adcreatives?.data?.[0]?.thumbnail_url || thumbnail_url || "";
          reportAd.sourceUrl =
            post.permalink_url || instagram_permalink_url || "";
        } else {
          reportAd.thumbnailUrl = thumbnail_url || "";
        }
      }),
    );

    return reportAds;
  }
}
