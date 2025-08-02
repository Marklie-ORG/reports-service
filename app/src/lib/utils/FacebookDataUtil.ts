import {
  type Ad,
  AVAILABLE_ADS_METRICS,
  AVAILABLE_CAMPAIGN_METRICS,
  AVAILABLE_GRAPH_METRICS,
  AVAILABLE_KPI_METRICS,
  type Campaign,
  type Graph,
  type KPIs,
  type SchedulingOptionMetrics,
} from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";
import { FacebookApi } from "../apis/FacebookApi.js";

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

  private static getLeads(values: any[], type: string): number {
    return Number(values?.find((a) => a.action_type === type)?.value || 0);
  }

  public static async getAllReportData(
    organizationUuid: string,
    accountId: string,
    datePreset: string,
    metrics: SchedulingOptionMetrics,
  ) {
    const api = await FacebookApi.create(organizationUuid, accountId);
    const fetches: Record<string, Promise<any[]>> = {};

    const selectedKpis = metrics.kpis?.metrics?.map((m) => m.name) || [];
    const selectedAds = metrics.ads?.metrics?.map((m) => m.name) || [];
    const selectedGraphs = metrics.graphs?.metrics?.map((m) => m.name) || [];
    const selectedCampaigns =
      metrics.campaigns?.metrics?.map((m) => m.name) || [];
    const customMetrics = metrics.customMetrics || [];

    const kpiFields = [
      ...this.resolveMetricsFromMap(selectedKpis, AVAILABLE_KPI_METRICS),
      ...(customMetrics.length ? ["actions"] : []),
    ];

    const adsFields = this.resolveMetricsFromMap(
      selectedAds,
      AVAILABLE_ADS_METRICS,
    );

    const graphFields = [
      ...this.resolveMetricsFromMap(
        [...selectedGraphs, "date_start", "date_stop"],

        AVAILABLE_GRAPH_METRICS,
      ),
      ...(customMetrics.length ? ["actions"] : []),
    ];

    const campaignFields = [
      ...this.resolveMetricsFromMap(
        [...selectedCampaigns, "campaign_id", "campaign_name"],
        AVAILABLE_CAMPAIGN_METRICS,
      ),
      ...(customMetrics.length ? ["actions"] : []),
    ];

    if (selectedKpis.length || customMetrics.length) {
      fetches.campaignDataForKPIs = api.getInsightsSmart(
        "campaign",
        kpiFields,
        {
          datePreset,
          additionalFields: ["campaign_id", "campaign_name"],
        },
      );
    }

    if (selectedAds.length) {
      fetches.ads = api.getAdInsightsWithThumbnails(adsFields, datePreset);
    }

    if (selectedGraphs.length || customMetrics.length) {
      fetches.campaignDataForGraphs = api.getInsightsSmart(
        "campaign",
        graphFields,
        {
          datePreset,
          timeIncrement: 1,
        },
      );
    }

    if (selectedCampaigns.length) {
      fetches.campaigns = api.getInsightsSmart("campaign", campaignFields, {
        datePreset,
      });
    }

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

    const KPIs = result.campaignDataForKPIs
      ? this.aggregateCampaignDataToKPIs(
          result.campaignDataForKPIs,
          selectedKpis,
          customMetrics,
        )
      : null;

    const graphs = result.campaignDataForGraphs
      ? this.aggregateCampaignDataToGraphs(
          result.campaignDataForGraphs,
          selectedGraphs,
          customMetrics,
        )
      : [];

    const campaigns = result.campaigns
      ? this.normalizeCampaigns(
          result.campaigns,
          selectedCampaigns,
          customMetrics,
        )
      : [];

    return {
      ads,
      kpis: KPIs,
      campaigns,
      graphs,
    };
  }

  private static aggregateCampaignDataToKPIs(
    campaignData: any[],
    selectedMetrics: string[],
    selectedCustomMetrics: { id: string; name: string }[] = [],
  ): KPIs | null {
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
          const type = action.action_type;
          const value = Number(action.value ?? 0);

          const match = type?.match(/^offsite_conversion\.custom\.(\d+)$/);
          if (match) {
            const id = match[1];
            const name = selectedCustomMap.get(id);
            if (name) {
              customMetricMap[name] = (customMetricMap[name] ?? 0) + value;
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
      spend: aggregated.spend,
      impressions: aggregated.impressions,
      clicks: aggregated.clicks,
      reach: aggregated.reach,
      purchases: aggregated.purchases,
      add_to_cart: aggregated.add_to_cart,
      initiated_checkouts: aggregated.initiated_checkouts,
      conversion_value: aggregated.conversion_value,
      engagement: aggregated.engagement,

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
      conversion_rate:
        aggregated.clicks > 0
          ? (aggregated.purchases / aggregated.clicks) * 100
          : 0,
      ...(aggregated.leads > 0
        ? {
            leads: aggregated.leads,
            cost_per_lead: aggregated.spend / aggregated.leads,
          }
        : {}),
    };

    for (const [name, value] of Object.entries(customMetricMap)) {
      metrics[name] = value;
    }

    const normalize = (s: string) => s.trim().toLowerCase();

    const allowedKeys = new Set([
      ...selectedMetrics.map(normalize),
      ...selectedCustomMetrics.map((m) => normalize(m.name)),
    ]);

    return Object.fromEntries(
      Object.entries(metrics).filter(([key]) =>
        allowedKeys.has(normalize(key)),
      ),
    );
  }

  private static aggregateCampaignDataToGraphs(
    campaignData: any[],
    selectedMetrics: string[],
    customMetrics: { id: string; name: string }[],
  ): Graph[] {
    if (!campaignData || campaignData.length === 0) return [];

    const dateGroups = new Map<string, any[]>();

    for (const dataPoint of campaignData) {
      const date = dataPoint.date_start;
      if (!dateGroups.has(date)) {
        dateGroups.set(date, []);
      }
      dateGroups.get(date)!.push(dataPoint);
    }

    const customMetricIdToName = new Map<string, string>();
    for (const cm of customMetrics) {
      customMetricIdToName.set(cm.id, cm.name);
    }

    const graphs: Graph[] = [];

    for (const [date, dayData] of dateGroups) {
      const aggregated: Record<string, number> = {
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

      for (const cm of customMetrics) {
        aggregated[cm.name] = 0;
      }

      for (const campaign of dayData) {
        aggregated.spend += Number(campaign.spend || 0);
        aggregated.impressions += Number(campaign.impressions || 0);
        aggregated.clicks += Number(campaign.clicks || 0);
        aggregated.reach += Number(campaign.reach || 0);

        if (campaign.actions) {
          for (const action of campaign.actions) {
            const { action_type, value } = action;
            if (!action_type || !value) continue;

            const match = action_type.match(
              /^offsite_conversion\.custom\.(\d+)$/,
            );
            if (match) {
              const id = match[1];
              const name = customMetricIdToName.get(id);
              if (name) {
                aggregated[name] = (aggregated[name] ?? 0) + Number(value);
              }
            }
          }

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
        }

        if (campaign.action_values) {
          aggregated.conversion_value += this.getActionMonetaryValue(
            campaign.action_values,
            "omni_purchase",
          );
        }
      }

      const graph: Record<string, any> = {
        date_start: date,
        date_stop: dayData[0].date_stop,
        spend: aggregated.spend,
        impressions: aggregated.impressions,
        clicks: aggregated.clicks,
        reach: aggregated.reach,
        purchases: aggregated.purchases,
        add_to_cart: aggregated.add_to_cart,
        initiated_checkouts: aggregated.initiated_checkouts,
        conversion_value: aggregated.conversion_value,
        engagement: aggregated.engagement,

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
          aggregated.reach > 0
            ? (aggregated.spend / aggregated.reach) * 1000
            : 0,
        purchase_roas:
          aggregated.spend > 0
            ? aggregated.conversion_value / aggregated.spend
            : 0,
        cost_per_purchase:
          aggregated.purchases > 0
            ? aggregated.spend / aggregated.purchases
            : 0,
        cost_per_add_to_cart:
          aggregated.add_to_cart > 0
            ? aggregated.spend / aggregated.add_to_cart
            : 0,
        conversion_rate:
          aggregated.clicks > 0
            ? (aggregated.purchases / aggregated.clicks) * 100
            : 0,
      };

      if (aggregated.leads > 0) {
        graph.leads = aggregated.leads;
        graph.cost_per_lead = aggregated.spend / aggregated.leads;
      }

      for (const cm of customMetrics) {
        graph[cm.name] = aggregated[cm.name];
      }

      const filteredGraph = Object.fromEntries(
        [...selectedMetrics, ...customMetrics.map((cm) => cm.name)]
          .map((key) => [key, graph[key]])
          .filter(([, v]) => v !== undefined),
      ) as Graph;

      filteredGraph.date_start = date;
      filteredGraph.date_stop = dayData[0].date_stop;

      graphs.push(filteredGraph);
    }

    graphs.sort(
      (a, b) =>
        new Date(a.date_start).getTime() - new Date(b.date_start).getTime(),
    );

    return graphs;
  }

  protected static normalizeKPIs(
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

    const leads = this.getLeads(apiData.actions, "lead");

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
      ...(leads > 0
        ? {
            leads,
            cost_per_lead: apiData.spend / leads,
          }
        : {}),
    };

    return Object.fromEntries(
      Object.entries(metrics).filter(([key]) => selectedMetrics.includes(key)),
    ) as KPIs;
  }

  protected static normalizeGraphs(graphs: any[], metrics: string[]): Graph[] {
    return graphs.map((g) => {
      const spend = parseFloat(g.spend || "0");
      const clicks = parseInt(g.clicks || "0");
      const purchases = this.getActionValue(g.actions, "omni_purchase");
      const add_to_cart = this.getActionValue(g.actions, "omni_add_to_cart");
      const leads = this.getLeads(g.actions, "lead");

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
        ...(leads > 0
          ? {
              leads,
              cost_per_lead: spend / leads,
            }
          : {}),
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
    customMetrics: { id: string; name: string }[] = [],
  ): Campaign[] {
    const customMetricIdToName = new Map<string, string>();
    for (const cm of customMetrics) {
      customMetricIdToName.set(cm.id, cm.name);
    }

    return campaigns.map((c, index) => {
      const spend = parseFloat(c.spend || "0");
      const clicks = parseInt(c.clicks || "0");
      const purchases = this.getActionValue(c.actions, "omni_purchase");
      const add_to_cart = this.getActionValue(c.actions, "omni_add_to_cart");
      const leads = this.getLeads(c.actions, "lead");

      const customMetricMap: Record<string, number> = {};

      if (c.actions) {
        for (const action of c.actions) {
          const { action_type, value } = action;
          if (!action_type || !value) continue;

          const match = action_type.match(
            /^offsite_conversion\.custom\.(\d+)$/,
          );
          if (match) {
            const id = match[1];
            const name = customMetricIdToName.get(id);
            if (name) {
              customMetricMap[name] =
                (customMetricMap[name] ?? 0) + Number(value);
            }
          }
        }
      }

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
        ...(leads > 0
          ? {
              leads,
              cost_per_lead: spend / leads,
            }
          : {}),
        ...customMetricMap,
      };

      const finalFields = [
        "index",
        "campaign_name",
        ...selectedMetrics,
        ...customMetrics.map((cm) => cm.name),
      ];

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
      const leads = this.getLeads(ad.actions, "lead");

      return {
        adId: ad.ad_id,
        adCreativeId: "",
        thumbnailUrl: "",
        sourceUrl: "",
        ad_name: ad.ad_name,
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
        ...(leads > 0
          ? {
              leads,
              cost_per_lead: spend / leads,
            }
          : {}),
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
