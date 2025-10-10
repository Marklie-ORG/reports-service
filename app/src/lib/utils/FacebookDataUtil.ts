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
      kpis: Metric[];
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
    if (selectedKpis.length && kpisCustom.length) {
      fieldsAggregate.push("actions", "action_values");
    }
    if (selectedCampaigns.length && campaignsCustom.length) {
      if (!fieldsAggregate.includes("actions")) fieldsAggregate.push("actions");
      if (!fieldsAggregate.includes("action_values"))
        fieldsAggregate.push("action_values");
    }

    if (fieldsAggregate.length) {
      const insightsAggregate = await api.getInsightsSmart(
        "campaign",
        [...new Set(fieldsAggregate)],
        {
          datePreset,
          additionalFields: ["campaign_id", "ad_id", "date_start", "date_stop"],
        },
      );

      if (selectedKpis.length) {
        result.kpis =
          this.aggregateCampaignDataToKPIs(
            insightsAggregate,
            selectedKpis,
            kpisCustom,
          ) ?? [];
      }
      if (selectedCampaigns.length) {
        result.campaigns = this.normalizeCampaigns(
          insightsAggregate,
          selectedCampaigns,
          campaignsCustom,
        );
      }
    }

    if (selectedGraphs.length) {
      const { since, until, days } = this.resolveRangeFromPreset(datePreset);
      const targetBuckets = Math.min(7, days); // or whatever max you want
      const timeIncrement = Math.ceil(days / targetBuckets);
      const fieldsTimeSeries: string[] = this.resolveMetricsFromMap(
        selectedGraphs,
        AVAILABLE_GRAPH_METRICS,
      );
      if (graphsCustom.length)
        fieldsTimeSeries.push("actions", "action_values");

      let insightsTimeSeries: any[] = [];
      if (fieldsTimeSeries.length) {
        insightsTimeSeries = await api.getInsightsSmart(
          "account",
          [...new Set(fieldsTimeSeries)],
          {
            customDateRange: { since, until },
            additionalFields: [
              "campaign_id",
              "ad_id",
              "date_start",
              "date_stop",
            ],
            timeIncrement,
          },
        );
      }

      result.graphs = this.createCollapsedBuckets(
        insightsTimeSeries,
        selectedGraphs,
        graphsCustom,
        datePreset,
        targetBuckets,
      );
    }

    if (selectedAds.length) {
      const resolvedAds = this.resolveMetricsFromMap(
        selectedAds,
        AVAILABLE_ADS_METRICS,
      );
      const adsCustom = adAccountConfig.ads.customMetrics ?? [];

      const adsInsights = await api.getAdInsightsWithThumbnails(
        [...resolvedAds, ...["actions", "action_values"]], // Andrii added this shit "...["actions", "action_values"]", because previously custom metrics didn't get fetched for creatives at all. Change it if needed.
        datePreset,
      );
      result.ads = await this.processAds(
        adsInsights,
        selectedAds,
        organizationUuid,
        adAccountId,
        adAccountConfig.ads.adsSettings,
        adsCustom,
      );
    }

    return result;
  }

  private static resolveRangeFromPreset(preset?: string): {
    since: string;
    until: string;
    days: number;
  } {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const toYMD = (d: Date) => d.toISOString().slice(0, 10);
    const daysBetween = (a: Date, b: Date) =>
      Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;

    const endsAt =
      preset === "today" ? today : new Date(today.getTime() - 86400000);

    const m = preset?.match(/^last_(\d+)d$/i);
    if (m) {
      const d = Math.max(1, parseInt(m[1], 10));
      const since = new Date(endsAt);
      since.setUTCDate(endsAt.getUTCDate() - (d - 1));
      return { since: toYMD(since), until: toYMD(endsAt), days: d };
    }

    const firstOfMonth = new Date(
      Date.UTC(endsAt.getUTCFullYear(), endsAt.getUTCMonth(), 1),
    );
    const firstOfLastMonth = new Date(
      Date.UTC(endsAt.getUTCFullYear(), endsAt.getUTCMonth() - 1, 1),
    );

    const currentQuarter = Math.floor(endsAt.getUTCMonth() / 3);
    const firstOfThisQuarter = new Date(
      Date.UTC(endsAt.getUTCFullYear(), currentQuarter * 3, 1),
    );
    const firstOfLastQuarter = new Date(
      Date.UTC(endsAt.getUTCFullYear(), (currentQuarter - 1) * 3, 1),
    );

    switch (preset) {
      case "today":
        return { since: toYMD(today), until: toYMD(today), days: 1 };

      case "yesterday":
        return { since: toYMD(endsAt), until: toYMD(endsAt), days: 1 };

      case "this_month":
        return {
          since: toYMD(firstOfMonth),
          until: toYMD(endsAt),
          days: daysBetween(firstOfMonth, endsAt),
        };

      case "last_month": {
        const end = new Date(firstOfMonth.getTime() - 86400000);
        return {
          since: toYMD(firstOfLastMonth),
          until: toYMD(end),
          days: daysBetween(firstOfLastMonth, end),
        };
      }

      case "this_quarter":
        return {
          since: toYMD(firstOfThisQuarter),
          until: toYMD(endsAt),
          days: daysBetween(firstOfThisQuarter, endsAt),
        };

      case "last_quarter": {
        const end = new Date(firstOfThisQuarter.getTime() - 86400000);
        return {
          since: toYMD(firstOfLastQuarter),
          until: toYMD(end),
          days: daysBetween(firstOfLastQuarter, end),
        };
      }

      case "last_3m": {
        const since = new Date(endsAt.getTime() - 89 * 86400000);
        return { since: toYMD(since), until: toYMD(endsAt), days: 90 };
      }

      case "last_90d": {
        const since = new Date(endsAt.getTime() - 89 * 86400000);
        return { since: toYMD(since), until: toYMD(endsAt), days: 90 };
      }

      case "lifetime":
        return {
          since: "2000-01-01",
          until: toYMD(endsAt),
          days: daysBetween(new Date("2000-01-01T00:00:00Z"), endsAt),
        };

      default: {
        const since = new Date(endsAt.getTime() - 6 * 86400000);
        return { since: toYMD(since), until: toYMD(endsAt), days: 7 };
      }
    }
  }

  private static createCollapsedBuckets(
    insights: any[],
    selectedGraphs: string[],
    customMetrics: CustomMetric[],
    _datePreset: string,
    _targetBuckets: number, // unused, because API does the bucketing
  ): ReportDataGraph[] {
    if (!insights.length) return [];

    const toYMD = (d: Date) => d.toISOString().slice(0, 10);

    return insights.map((row) => ({
      date_start: toYMD(new Date(row.date_start)),
      date_stop: toYMD(new Date(row.date_stop)),
      data: this.extractMetricsFromInsight(row, selectedGraphs, customMetrics),
    }));
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
      landing_page_views: 0,
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
      aggregated.landing_page_views += this.getActionValue(
        campaign.actions,
        "landing_page_view",
      );
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
        aggregated.landing_page_views > 0
          ? (aggregated.purchases / aggregated.landing_page_views) * 100
          : 0,
      ...customMetricMap,
    };

    for (const cm of selectedCustomMetrics) {
      if (!(cm.name in metrics)) {
        metrics[cm.name] = 0;
      }
    }

    // TODO: CUSTOM VETSOCIAL CODE
    const quotesCm = selectedCustomMetrics.find((cm) =>
      cm.name.toLowerCase().includes("quote") || cm.name.toLowerCase().includes("anvraag"),
    );
    if (quotesCm) {
      const qName = quotesCm.name;
      const qVal = Number(metrics[qName] ?? 0);
      metrics["cost_per_quote"] = qVal > 0 ? aggregated.spend / qVal : 0;
    }

    const normalize = (s: string) => s.trim().toLowerCase();
    const allowedKeys = new Set([
      ...selectedMetrics.map(normalize),
      ...selectedCustomMetrics.map((m) => normalize(m.name)),
    ]);
    if (quotesCm) {
      allowedKeys.add("cost_per_quote");
    }
    const metricOrderMap = new Map<string, number>();
    selectedMetrics.forEach((name, index) => {
      metricOrderMap.set(name.trim().toLowerCase(), index);
    });
    selectedCustomMetrics.forEach((cm) => {
      metricOrderMap.set(cm.name.trim().toLowerCase(), cm.order);
    });
    if (quotesCm) {
      metricOrderMap.set("cost_per_quote", 50);
    }
    return Object.entries(metrics)
      .filter(([key]) => allowedKeys.has(normalize(key)))
      .map(([name, value]) => ({
        name,
        value,
        order: metricOrderMap.get(normalize(name)) ?? 999,
      }))
      .sort((a, b) => a.order - b.order);
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
    const landing_page_views = this.getActionValue(
      insight.actions,
      "landing_page_view",
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
      conversion_rate:
        landing_page_views > 0 ? (purchases / landing_page_views) * 100 : 0,
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

    // TODO: CUSTOM VETSOCIAL CODE
    const quotesCm = customMetrics.find((cm) =>
      cm.name.toLowerCase().includes("quote") || cm.name.toLowerCase().includes("anvraag"),
    );
    if (quotesCm) {
      const qName = quotesCm.name;
      const qVal = Number(metricsMap[qName] ?? 0);
      metricsMap["cost_per_quote"] = qVal > 0 ? spend / qVal : 0;
    }

    const normalizeKey = (key: string) => key.toLowerCase();
    const allowedMetrics = new Set<string>([
      ...selectedMetrics.map(normalizeKey),
      ...customMetrics.map((cm) => normalizeKey(cm.name)),
    ]);
    if (quotesCm) {
      allowedMetrics.add("cost_per_quote");
    }

    const metricOrderMap = new Map<string, number>();
    selectedMetrics.forEach((name, index) => {
      metricOrderMap.set(normalizeKey(name), index);
    });
    customMetrics.forEach((cm) => {
      metricOrderMap.set(normalizeKey(cm.name), cm.order);
    });
    if (quotesCm) {
      metricOrderMap.set("cost_per_quote", 50);
    }

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
    
    // TODO: CUSTOM VETSOCIAL SORTING
    const sortMetric = allCustomMetrics.find((metric) => metric.name.toLowerCase().includes("quote") || metric.name.toLowerCase().includes("anvraag"))?.name || "spend";

    const campaigns = insights.map((campaign, index) => ({
      index,
      campaign_name: campaign.campaign_name || `Campaign ${index + 1}`,
      data: this.extractMetricsFromInsight(
        campaign,
        selectedCampaigns.filter((m) => m !== "campaign_name"),
        allCustomMetrics,
      ),
    }))

    const sortedCampaigns = campaigns.sort((a, b) => {
      const valueA = Number(a.data.find((m) => m.name === sortMetric)?.value || 0);
      const valueB = Number(b.data.find((m) => m.name === sortMetric)?.value || 0);
      return valueB - valueA;
    });

    return sortedCampaigns.slice(0, 15);
  }

  private static getBestAdsByROAS(
    ads: any[],
    metric: string = "impressions",
    limit: number = 10,
  ): any[] {
    const getMetricValue = (ad: any, key: string): number => {
      const list = ad?.data ?? [];
      const row = Array.isArray(list)
        ? list.find(
            (m: any) =>
              String(m?.name ?? "").toLowerCase() === key.toLowerCase(),
          )
        : undefined;
      let val = row?.value;

      if (val == null) return 0;

      // normalize numbers / "12.3%" strings
      if (typeof val === "string") {
        val = parseFloat(val.replace("%", ""));
        if (Number.isNaN(val)) return 0;
      }
      if (typeof val !== "number") return 0;

      return val;
    };

    return ads
      .slice()
      .sort((a, b) => {
        const aVal = getMetricValue(a, metric);
        const bVal = getMetricValue(b, metric);

        if (!aVal && !bVal) return 0;
        if (!aVal) return 1;
        if (!bVal) return -1;

        return bVal - aVal;
      })
      .slice(0, limit);
  }

  private static async processAds(
    adsInsights: any[],
    selectedAds: string[],
    organizationUuid: string,
    adAccountId: string,
    adsSettings?: { numberOfAds: number; sortAdsBy: string },
    customMetrics: CustomMetric[] = [],
  ): Promise<ReportDataAd[]> {
    const api = await FacebookApi.create(organizationUuid, adAccountId);

    // STEP 1: Aggregate ads by ad_id
    const aggregatedAds = this.aggregateAdsByAdName(adsInsights);

    const creativeByAdId = new Map<string, any>();
    const igMediaIds = new Set<string>();
    const storyIdsByPage = new Map<string, string[]>();

    // collect creatives & ids for media enrichment (use aggregated ads)
    for (const r of aggregatedAds) {
      const cr = r.creative || {};
      const adId = r.ad_id || r.adId;
      creativeByAdId.set(adId, cr);

      const storyId = cr.effective_object_story_id as string | undefined;
      const pageId = this.extractPageIdFromStoryId(storyId);
      if (pageId && storyId) {
        if (!storyIdsByPage.has(pageId)) storyIdsByPage.set(pageId, []);
        storyIdsByPage.get(pageId)!.push(storyId);
      }

      const mediaId = cr.effective_instagram_media_id as string | undefined;
      if (mediaId) igMediaIds.add(mediaId);
    }

    // Use aggregated ads instead of raw insights
    const reportAds: ReportDataAd[] = aggregatedAds.map((row) => ({
      adId: row.ad_id || row.adId,
      adCreativeId: (row.creative?.id as string) || "",
      thumbnailUrl: row.creative?.thumbnail_url || "",
      sourceUrl: row.creative?.instagram_permalink_url || "",
      ad_name: row.ad_name || "",
      data: this.extractMetricsFromInsight(row, selectedAds, customMetrics),
    }));

    const shownAds = this.getBestAdsByROAS(
      reportAds,
      adsSettings?.sortAdsBy,
      adsSettings?.numberOfAds,
    );

    const managedPages = await api.getManagedPages();
    const tokenByPage = new Map(
      managedPages.map((p) => [p.id, p.access_token]),
    );

    const igById = new Map<string, any>();
    const firstPageToken = managedPages[0]?.access_token;
    if (igMediaIds.size && firstPageToken) {
      try {
        const ig = await api.getInstagramMediaBatchWithToken(
          firstPageToken,
          [...igMediaIds],
          [
            "id",
            "media_type",
            "media_url",
            "thumbnail_url",
            "permalink",
            "children{media_type,media_url,thumbnail_url,permalink}",
          ],
        );
        for (const m of ig || []) igById.set(m.id, m);
      } catch {}
    }

    const postById = new Map<string, any>();
    for (const [pageId, storyIds] of storyIdsByPage.entries()) {
      const token = tokenByPage.get(pageId);
      if (!token) continue;
      const unique = [...new Set(storyIds)];
      try {
        const posts = await api.getEntitiesBatchWithToken(token, unique, [
          "id",
          "permalink_url",
          "full_picture",
          "attachments{media_type,media,url,subattachments{media_type,media,url}}",
        ]);
        for (const p of posts || []) postById.set(p.id, p);
      } catch {}
    }

    for (const ra of shownAds) {
      const cr = creativeByAdId.get(ra.adId);

      if (cr?.effective_instagram_media_id) {
        const media = igById.get(cr.effective_instagram_media_id);
        if (media) {
          if (
            media.media_type === "CAROUSEL_ALBUM" &&
            media.children?.data?.length
          ) {
            const first = media.children.data[0];
            ra.thumbnailUrl =
              (first.media_type === "IMAGE" && !first.thumbnail_url
                ? first.media_url
                : first.thumbnail_url) || ra.thumbnailUrl;
            ra.sourceUrl = first.permalink || media.permalink || ra.sourceUrl;
          } else {
            ra.thumbnailUrl =
              (media.media_type === "IMAGE" && !media.thumbnail_url
                ? media.media_url
                : media.thumbnail_url) || ra.thumbnailUrl;
            ra.sourceUrl = media.permalink || ra.sourceUrl;
          }
          continue;
        }
      }

      if (cr?.effective_object_story_id) {
        const post = postById.get(cr.effective_object_story_id);
        if (post) {
          const pickFromAttachments = (att: any): string | null => {
            if (!att) return null;
            const first = att.data?.[0];
            if (!first) return null;
            return (
              first.media?.image?.src ||
              first.media?.source ||
              first.media?.src ||
              first.url ||
              first.subattachments?.data?.[0]?.media?.image?.src ||
              first.subattachments?.data?.[0]?.media?.source ||
              first.subattachments?.data?.[0]?.media?.src ||
              first.subattachments?.data?.[0]?.url ||
              null
            );
          };
          ra.thumbnailUrl =
            pickFromAttachments(post.attachments) ||
            post.full_picture ||
            ra.thumbnailUrl;
          ra.sourceUrl = post.permalink_url || ra.sourceUrl;
        }
      }
    }

    return shownAds;
  }

  // NEW METHOD: Aggregate ads by ad_id
  private static aggregateAdsByAdName(adsInsights: any[]): any[] {
    const nameMap = new Map<string, any>();

    const isNumericLike = (v: any) =>
      typeof v === "number" ||
      (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)));

    for (const row of adsInsights) {
      const adName = row.ad_name || "Unnamed Ad";
      if (!nameMap.has(adName)) {
        nameMap.set(adName, { ...row });
        continue;
      }

      const existing = nameMap.get(adName)!;

      // sum numeric & numeric-like string fields
      for (const [key, value] of Object.entries(row)) {
        if (key === "ad_id" || key === "adId" || key === "ad_name") continue;
        if (isNumericLike(value)) {
          const prev = Number(existing[key] ?? 0);
          existing[key] = prev + Number(value);
        }
      }

      // merge actions
      if (Array.isArray(row.actions)) {
        if (!existing.actions) existing.actions = [];
        const actionMap = new Map<string, number>();
        for (const a of existing.actions)
          actionMap.set(a.action_type, Number(a.value ?? 0));
        for (const a of row.actions) {
          const t = a.action_type;
          actionMap.set(t, (actionMap.get(t) ?? 0) + Number(a.value ?? 0));
        }
        existing.actions = [...actionMap.entries()].map(
          ([action_type, value]) => ({
            action_type,
            value: String(value),
          }),
        );
      }

      // merge action_values
      if (Array.isArray(row.action_values)) {
        if (!existing.action_values) existing.action_values = [];
        const valMap = new Map<string, number>();
        for (const av of existing.action_values)
          valMap.set(av.action_type, Number(av.value ?? 0));
        for (const av of row.action_values) {
          const t = av.action_type;
          valMap.set(t, (valMap.get(t) ?? 0) + Number(av.value ?? 0));
        }
        existing.action_values = [...valMap.entries()].map(
          ([action_type, value]) => ({
            action_type,
            value: String(value),
          }),
        );
      }
    }

    const result = [...nameMap.values()];
    console.log(
      `Aggregated ${adsInsights.length} ad rows into ${result.length} unique ad_names`,
    );
    return result;
  }

  private static extractPageIdFromStoryId(storyId?: string): string | null {
    if (!storyId) return null;
    const m = String(storyId).match(/^(\d+)_\d+$/);
    return m ? m[1] : null;
  }
}
