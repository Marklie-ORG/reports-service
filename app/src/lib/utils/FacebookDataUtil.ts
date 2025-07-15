import { FacebookApi } from "../apis/FacebookApi.js";
import {
  type Ad,
  AVAILABLE_ADS_METRICS,
  AVAILABLE_CAMPAIGN_METRICS,
  AVAILABLE_GRAPH_METRICS,
  AVAILABLE_KPI_METRICS,
  type Campaign,
  type Graph,
  type KPIs,
  type ReportData,
  type SchedulingOptionMetrics,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";

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

  public static async getAllReportData(
    organizationUuid: string,
    accountId: string,
    datePreset: string,
    metrics: SchedulingOptionMetrics,
  ): Promise<ReportData> {
    const api = await FacebookApi.create(organizationUuid, accountId);
    const fetches: Record<string, Promise<any[]>> = {};

    const selectedKpis = metrics.kpis?.metrics?.map((m) => m.name) || [];
    const selectedAds = metrics.ads?.metrics?.map((m) => m.name) || [];
    const selectedGraphs = metrics.graphs?.metrics?.map((m) => m.name) || [];
    const selectedCampaigns =
      metrics.campaigns?.metrics?.map((m) => m.name) || [];

    const kpiFields = this.resolveMetricsFromMap(
      selectedKpis,
      AVAILABLE_KPI_METRICS,
    );
    const adsFields = this.resolveMetricsFromMap(
      selectedAds,
      AVAILABLE_ADS_METRICS,
    );
    const graphFields = this.resolveMetricsFromMap(
      [...selectedGraphs, "date_start", "date_stop"],
      AVAILABLE_GRAPH_METRICS,
    );
    const campaignFields = this.resolveMetricsFromMap(
      [...selectedCampaigns, "campaign_id", "campaign_name"],
      AVAILABLE_CAMPAIGN_METRICS,
    );

    if (selectedKpis.length)
      fetches.KPIs = api.getInsightsSmart("account", kpiFields, { datePreset });

    if (selectedAds.length)
      fetches.ads = api.getAdInsightsWithThumbnails(api, adsFields, datePreset);

    if (selectedGraphs.length)
      fetches.graphs = api.getInsightsSmart("account", graphFields, {
        datePreset,
        timeIncrement: 1,
      });

    if (selectedCampaigns.length)
      fetches.campaigns = api.getInsightsSmart("campaign", campaignFields, {
        datePreset,
      });

    const resolved = await Promise.all(
      Object.entries(fetches).map(([key, promise]) =>
        promise.then((data) => [key, data]),
      ),
    );

    const result = Object.fromEntries(resolved);

    const ads = result.ads
      ? await this.processAds(
          result.ads,
          selectedAds,
          organizationUuid,
          accountId,
        )
      : [];

    return {
      ads,
      KPIs: result.KPIs?.[0]
        ? this.normalizeKPIs(result.KPIs[0], selectedKpis)
        : null,
      campaigns: result.campaigns
        ? this.normalizeCampaigns(result.campaigns, selectedCampaigns)
        : [],
      graphs: result.graphs
        ? this.normalizeGraphs(result.graphs, selectedGraphs)
        : [],
    };
  }

  private static normalizeKPIs(
    apiData: any,
    selectedMetrics: string[],
  ): KPIs | null {
    if (!apiData) return null;

    const purchases = this.getActionValue(apiData.actions, "omni_purchase");
    const add_to_cart = this.getActionValue(
      apiData.actions,
      "omni_add_to_cart",
    );
    const initiated_checkouts = this.getActionValue(
      apiData.actions,
      "initiate_checkout",
    );
    const conversion_value = this.getActionMonetaryValue(
      apiData.action_values,
      "omni_purchase",
    );

    const metrics: KPIs = {
      spend: apiData.spend,
      impressions: apiData.impressions,
      clicks: apiData.clicks,
      cpc: apiData.cpc,
      ctr: apiData.ctr,
      cpm: apiData.cpm,
      cpp: apiData.cpp,
      reach: apiData.reach,
      purchase_roas: apiData.purchase_roas?.[0]?.value || 0,
      purchases,
      add_to_cart,
      initiated_checkouts,
      conversion_value,
      cost_per_purchase: purchases > 0 ? apiData.spend / purchases : 0,
      cost_per_add_to_cart: add_to_cart > 0 ? apiData.spend / add_to_cart : 0,
      conversion_rate:
        apiData.clicks > 0 ? (purchases / apiData.clicks) * 100 : 0,
      engagement:
        this.getActionValue(apiData.actions, "post_engagement") ||
        this.getActionValue(apiData.actions, "page_engagement") ||
        0,
    };

    return Object.fromEntries(
      Object.entries(metrics).filter(([key]) => selectedMetrics.includes(key)),
    ) as KPIs;
  }

  private static normalizeGraphs(graphs: any[], metrics: string[]): Graph[] {
    return graphs.map((g) => {
      const spend = parseFloat(g.spend || "0");
      const clicks = parseInt(g.clicks || "0");
      const purchases = this.getActionValue(g.actions, "omni_purchase");
      const add_to_cart = this.getActionValue(g.actions, "omni_add_to_cart");

      const graph: Graph = {
        date_start: g.date_start,
        date_stop: g.date_stop,
        spend,
        impressions: parseInt(g.impressions || "0"),
        clicks,
        cpc: g.cpc,
        ctr: g.ctr,
        cpm: g.cpm,
        cpp: g.cpp,
        reach: g.reach,
        purchase_roas: g.purchase_roas?.[0]?.value || 0,
        purchases,
        add_to_cart,
        initiated_checkouts: this.getActionValue(
          g.actions,
          "initiate_checkout",
        ),
        conversion_value: this.getActionMonetaryValue(
          g.action_values,
          "omni_purchase",
        ),
        cost_per_purchase: purchases > 0 ? spend / purchases : 0,
        cost_per_add_to_cart: add_to_cart > 0 ? spend / add_to_cart : 0,
        conversion_rate: clicks > 0 ? (purchases / clicks) * 100 : 0,
        engagement:
          this.getActionValue(g.actions, "post_engagement") ||
          this.getActionValue(g.actions, "page_engagement") ||
          0,
      };

      return Object.fromEntries(
        metrics
          .map((key) => [key, graph[key as keyof Graph]])
          .filter(([, v]) => v !== undefined),
      ) as Graph;
    });
  }

  private static normalizeCampaigns(
    campaigns: any[],
    selectedMetrics: string[],
  ): Campaign[] {
    return campaigns.map((c, index) => {
      const spend = parseFloat(c.spend || "0");
      const clicks = parseInt(c.clicks || "0");
      const purchases = this.getActionValue(c.actions, "omni_purchase");
      const add_to_cart = this.getActionValue(c.actions, "omni_add_to_cart");

      const campaign: Campaign = {
        index,
        campaign_name: c.campaign_name,
        spend,
        impressions: c.impressions,
        clicks,
        cpc: c.cpc,
        ctr: c.ctr,
        cpm: c.cpm,
        cpp: c.cpp,
        reach: c.reach,
        purchase_roas: c.purchase_roas?.[0]?.value || 0,
        purchases,
        add_to_cart,
        initiated_checkouts: this.getActionValue(
          c.actions,
          "initiate_checkout",
        ),
        conversion_value: this.getActionMonetaryValue(
          c.action_values,
          "omni_purchase",
        ),
        cost_per_purchase: purchases > 0 ? spend / purchases : 0,
        cost_per_add_to_cart: add_to_cart > 0 ? spend / add_to_cart : 0,
        conversion_rate: clicks > 0 ? (purchases / clicks) * 100 : 0,
        engagement:
          this.getActionValue(c.actions, "post_engagement") ||
          this.getActionValue(c.actions, "page_engagement") ||
          0,
      };

      const finalFields = ["index", "campaign_name", ...selectedMetrics];
      Object.keys(campaign).forEach((key) => {
        if (!finalFields.includes(key)) {
          delete campaign[key as keyof Campaign];
        }
      });

      return campaign;
    });
  }

  private static getBest10AdsByROAS(ads: any[], metric: string): any[] {
    return ads
      .filter((ad) => ad[metric])
      .sort((a, b) => parseFloat(b[metric]) - parseFloat(a[metric]))
      .slice(0, 10);
  }

  private static async processAds(
    ads: any[],
    selectedMetrics: string[],
    organizationUuid: string,
    accountId: string,
  ): Promise<Ad[]> {
    const shownAds = this.getBest10AdsByROAS(ads, "impressions");
    const api = await FacebookApi.create(organizationUuid, accountId);

    const reportAds: Ad[] = shownAds.map((ad) => {
      const clicks = parseInt(ad.clicks || "0");
      const spend = parseFloat(ad.spend || "0");
      const purchases = this.getActionValue(ad.actions, "omni_purchase");
      const add_to_cart = this.getActionValue(ad.actions, "omni_add_to_cart");

      return {
        adId: ad.ad_id,
        adCreativeId: "",
        thumbnailUrl: "",
        sourceUrl: "",
        spend,
        impressions: ad.impressions,
        clicks,
        cpc: ad.cpc,
        ctr: ad.ctr,
        cpm: ad.cpm,
        cpp: ad.cpp,
        reach: ad.reach,
        purchase_roas: ad.purchase_roas?.[0]?.value || 0,
        purchases,
        add_to_cart,
        initiated_checkouts: this.getActionValue(
          ad.actions,
          "initiate_checkout",
        ),
        conversion_value: this.getActionMonetaryValue(
          ad.action_values,
          "omni_purchase",
        ),
        cost_per_purchase: purchases > 0 ? spend / purchases : 0,
        cost_per_add_to_cart: add_to_cart > 0 ? spend / add_to_cart : 0,
        conversion_rate: clicks > 0 ? (purchases / clicks) * 100 : 0,
        engagement:
          this.getActionValue(ad.actions, "post_engagement") ||
          this.getActionValue(ad.actions, "page_engagement") ||
          0,
      };
    });

    const adIds = shownAds.map((a) => a.ad_id);
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

    const finalKeys = [
      "adId",
      "adCreativeId",
      "thumbnailUrl",
      "sourceUrl",
      ...selectedMetrics,
    ];
    reportAds.forEach((ad) => {
      Object.keys(ad).forEach((key) => {
        if (!finalKeys.includes(key)) {
          delete ad[key as keyof Ad];
        }
      });
    });

    return reportAds;
  }
}
