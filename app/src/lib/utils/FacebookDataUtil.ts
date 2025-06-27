import { FacebookApi } from "../apis/FacebookApi.js";
import {
    type Ad,
    AVAILABLE_ADS_METRICS,
    AVAILABLE_CAMPAIGN_METRICS, AVAILABLE_GRAPH_METRICS, AVAILABLE_KPI_METRICS, type AvailableKpiMetric,
    type Campaign, type Graph, type KPIs, type ReportData,
    type SchedulingOptionMetrics
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";


export class FacebookDataUtil {

    static determineCampaignFieldsBasedOnSelectedMetrics(selectedMetrics: string[]): string[] {
        let metrics = selectedMetrics.map(metric => {
            if (AVAILABLE_CAMPAIGN_METRICS[metric]) {
                return AVAILABLE_CAMPAIGN_METRICS[metric]
            }
            return [metric];
        }).flat();
        return [...new Set(metrics)];
    }

    public static async getAllReportData(
        organizationUuid: string,
        accountId: string,
        datePreset: string,
        metrics: SchedulingOptionMetrics
    ): Promise<ReportData> {
        const api = await FacebookApi.create(organizationUuid, accountId);

        const fetches: Record<string, Promise<any[]>> = {};

        const selectedKpiMetrics: string[] = metrics.kpis?.metrics?.length ? metrics.kpis.metrics.map(m => m.name) : [];
        const kpiApiFields = this.determineKpisFieldsBasedOnSelectedMetrics(selectedKpiMetrics);

        const selectedAdsMetrics: string[] = metrics.ads?.metrics?.length ? metrics.ads.metrics.map(m => m.name) : [];
        const adsApiFields = this.determineAdsFieldsBasedOnSelectedMetrics(selectedAdsMetrics);

        const obligatoryGraphsMetrics = ["date_start", "date_stop"];
        const selectedGraphsMetrics = metrics.graphs?.metrics?.length ? 
            [ ...metrics.graphs.metrics.map(m => m.name), ...obligatoryGraphsMetrics ] : [];
        const graphApiFields = this.determineGraphFieldsBasedOnSelectedMetrics(selectedGraphsMetrics);

        const obligatoryCampaignMetrics = ["campaign_id", "campaign_name"];
        const campaignMetrics = metrics.campaigns?.metrics?.length ? 
            [ ...metrics.campaigns.metrics.map(m => m.name), ...obligatoryCampaignMetrics ] : [];
        const campaignApiFields = this.determineCampaignFieldsBasedOnSelectedMetrics(campaignMetrics);

        if (selectedKpiMetrics.length) fetches.KPIs = api.getInsightsSmart("account", kpiApiFields, { datePreset });

        if (selectedAdsMetrics.length) fetches.ads = api.getAdInsightsWithThumbnails(api, adsApiFields, datePreset);

        if (selectedGraphsMetrics.length) fetches.graphs = api.getInsightsSmart("account", graphApiFields, { datePreset, timeIncrement: 1 });

        if (metrics.campaigns?.metrics?.length) fetches.campaigns = api.getInsightsSmart("campaign", campaignApiFields, { datePreset });

        const resolved = await Promise.all(
            Object.entries(fetches).map(([key, promise]) =>
                promise.then((data) => [key, data])
            )
        );

        const result: Record<string, any> = Object.fromEntries(resolved);

        const ads = result.ads ? await this.processAds(result.ads, selectedAdsMetrics, organizationUuid, accountId) : [];

        const reportData: ReportData = {
            KPIs: result.KPIs?.length ? this.normalizeKPIs(result.KPIs[0], selectedKpiMetrics) : null,
            graphs: result.graphs ? this.normalizeGraphs(result.graphs, selectedGraphsMetrics) : [],
            ads: ads,
            campaigns: result.campaigns ? this.normalizeCampaigns(result.campaigns, campaignMetrics) : []
        };

        return reportData;
    }

    static determineKpisFieldsBasedOnSelectedMetrics(selectedMetrics: string[]): string[] {
        const metrics = selectedMetrics.map(metric => AVAILABLE_KPI_METRICS[metric]).flat();
        return [...new Set(metrics)];
    }

    private static normalizeKPIs(apiData: any, selectedMetrics: any[]): KPIs | null {
        if (!apiData) return null;

        const getActionValue = (type: string): number =>
            Number(apiData.actions?.find((a: any) => a.action_type === type)?.value || 0);

        const getActionMonetaryValue = (type: string): number =>
            Number(apiData.action_values?.find((a: any) => a.action_type === type)?.value || 0);

        const purchases = getActionValue("omni_purchase");
        const add_to_cart = getActionValue("omni_add_to_cart");
        const initiated_checkouts = getActionValue("initiate_checkout");
        const conversion_value = getActionMonetaryValue("omni_purchase");

        const allMetrics: KPIs = {
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

            cost_per_purchase: purchases > 0 ? (apiData.spend / purchases) : 0,
            cost_per_add_to_cart: add_to_cart > 0 ? (apiData.spend / add_to_cart) : 0,
            conversion_rate: apiData.clicks > 0 ? (purchases / apiData.clicks) * 100 : 0,
            engagement: getActionValue("post_engagement") || getActionValue("page_engagement") || 0
        };

        const filteredMetrics = Object.fromEntries(
            Object.entries(allMetrics)
                .filter(([key]) => selectedMetrics.includes(key as AvailableKpiMetric)) // leave only selected metrics
                .filter(([_, value]) => value !== undefined)
        );

        return filteredMetrics;
    }

    private static normalizeGraphs(graphs: any[], metrics: string[]) {
        return graphs.map((g) => {
            const spend = parseFloat(g.spend || "0");
            const clicks = parseInt(g.clicks || "0");
            const impressions = parseInt(g.impressions || "0");

            const actions: Record<string, number> = Object.fromEntries(
                (g.actions || []).map((a: any) => [a.action_type, Number(a.value)])
            );

            const getActionValue = (type: string): number => actions[type] || 0;

            const getActionMonetaryValue = (type: string): number =>
                Number(g.action_values?.find((a: any) => a.action_type === type)?.value || 0);

            const purchases = getActionValue("omni_purchase");
            const add_to_cart = getActionValue("omni_add_to_cart");
            const initiated_checkouts = getActionValue("initiate_checkout");
            const conversion_value = getActionMonetaryValue("omni_purchase");

            const graph: Graph = {
                date_start: g.date_start,
                date_stop: g.date_stop,

                spend,
                impressions,
                clicks,
                cpc: g.cpc,
                ctr: g.ctr,
                cpm: g.cpm,
                cpp: g.cpp,
                reach: g.reach,
                purchase_roas: g.purchase_roas?.[0]?.value || 0,
                purchases,
                add_to_cart,
                initiated_checkouts,
                conversion_value,

                cost_per_purchase: purchases > 0 ? (spend / purchases) : 0,
                cost_per_add_to_cart: add_to_cart > 0 ? (spend / add_to_cart) : 0,
                conversion_rate: clicks > 0 ? (purchases / clicks) * 100 : 0,
                engagement: getActionValue("post_engagement") || getActionValue("page_engagement") || 0,
            };

            return Object.fromEntries(
                metrics.map((key) => [key, graph[key as keyof Graph]]).filter(([, value]) => value !== undefined)
            );
        });
    }

    static determineGraphFieldsBasedOnSelectedMetrics(selectedMetrics: string[]): string[] {
        let metrics = selectedMetrics.map(metric => {
            if (AVAILABLE_GRAPH_METRICS[metric]) {
                return AVAILABLE_GRAPH_METRICS[metric]
            }
            return [metric];
        }).flat();
        return [...new Set(metrics)];
    }

    private static normalizeCampaigns(campaigns: any[], selectedMetrics: string[]): any[] {
        const defaultCampaignKeys = ["index", "campaign_name"];
        const results: Campaign[] = [];

        for (const [index, c] of campaigns.entries()) {
            const actions = c.actions || [];

            const getActionValue = (type: string): number =>
                Number(actions.find((a: any) => a.action_type === type)?.value || 0);

            const getActionMonetaryValue = (type: string): number =>
                Number(c.action_values?.find((a: any) => a.action_type === type)?.value || 0);
            
            const purchases = getActionValue("omni_purchase");
            const add_to_cart = getActionValue("omni_add_to_cart");
            const initiated_checkouts = getActionValue("initiate_checkout");
            const conversion_value = getActionMonetaryValue("omni_purchase");

            const entry: Campaign = {
                index,
                campaign_name: c.campaign_name,
                
                spend: c.spend,
                impressions: c.impressions,
                clicks: c.clicks,
                cpc: c.cpc,
                ctr: c.ctr,
                cpm: c.cpm,
                cpp: c.cpp,
                reach: c.reach,
                purchase_roas: c.purchase_roas?.[0]?.value || 0,
                purchases,
                add_to_cart,
                initiated_checkouts,
                conversion_value,

                cost_per_purchase: purchases > 0 ? (c.spend / purchases) : 0,
                cost_per_add_to_cart: add_to_cart > 0 ? (c.spend / add_to_cart) : 0,
                conversion_rate: c.clicks > 0 ? (purchases / c.clicks) * 100 : 0,
                engagement: getActionValue("post_engagement") || getActionValue("page_engagement") || 0
            };

            results.push(entry);
        }

        const finalFields = [...defaultCampaignKeys, ...selectedMetrics];
        results.forEach((adObject: any) => {
            Object.keys(adObject).forEach((key: string) => {
                if (!finalFields.includes(key)) {
                    delete adObject[key];
                }
            });
        });

        return results;
    }

    static determineAdsFieldsBasedOnSelectedMetrics(selectedMetrics: string[]): string[] {
        const metrics = selectedMetrics.map(metric => AVAILABLE_ADS_METRICS[metric]).flat();
        return [...new Set(metrics)];
    }

    private static getBest10AdsByROAS(ads: any[], metric: string): any[] {
        return ads
            .filter((ad) => ad[metric])
            .sort((a, b) => {
                const roasA = parseFloat(a[metric]);
                const roasB = parseFloat(b[metric]);
                return roasB - roasA;
            })
            .slice(0, 10);
    }

    private static async processAds(
        ads: any[],
        selectedMetrics: string[],
        organizationUuid: string,
        accountId: string
    ) {
        const defaultAdKeys = ["adId", "adCreativeId", "thumbnailUrl", "sourceUrl"];
        const shownAds = this.getBest10AdsByROAS(ads, "impressions");
        const api = await FacebookApi.create(organizationUuid, accountId);

        const reportAds = shownAds.map((ad) => {
            const getActionValue = (type: string) =>
                ad.actions?.find((a: any) => a.action_type === type)?.value ?? "0";

            const getActionMonetaryValue = (type: string): number =>
                Number(ad.action_values?.find((a: any) => a.action_type === type)?.value || 0);

            const purchases = getActionValue("omni_purchase");
            const add_to_cart = getActionValue("omni_add_to_cart");
            const initiated_checkouts = getActionValue("initiate_checkout");
            const conversion_value = getActionMonetaryValue("omni_purchase");

            const adObject: Ad = {
                adId: ad.ad_id,
                adCreativeId: "",
                thumbnailUrl: "",
                sourceUrl: "",
                
                spend: ad.spend,
                impressions: ad.impressions,
                clicks: ad.clicks,
                cpc: ad.cpc,
                ctr: ad.ctr,
                cpm: ad.cpm,
                cpp: ad.cpp,
                reach: ad.reach,
                purchase_roas: ad.purchase_roas?.[0]?.value || 0,
                purchases,
                add_to_cart,
                initiated_checkouts,
                conversion_value,

                cost_per_purchase: purchases > 0 ? (ad.spend / purchases) : 0,
                cost_per_add_to_cart: add_to_cart > 0 ? (ad.spend / add_to_cart) : 0,
                conversion_rate: ad.clicks > 0 ? (purchases / ad.clicks) * 100 : 0,
                engagement: getActionValue("post_engagement") || getActionValue("page_engagement") || 0
            };

            return adObject;
        });

        const adIds = shownAds.map((a) => a.ad_id).filter(Boolean);
        const adEntities = await api.getEntitiesBatch(adIds, ["id", "creative{id}"]);

        const creativeIds = adEntities
          .map((ad: { creative: { id: any } }) => ad.creative?.id)
          .filter((id: any): id is string => !!id);

        const creativeAssets = await api.getEntitiesBatch(creativeIds, [
            "id",
            "effective_instagram_media_id",
            "effective_object_story_id",
            "thumbnail_url",
            "instagram_permalink_url"
        ]);

        reportAds.forEach((reportAd) => {
            const adEntity = adEntities.find(
              (a: { id: any }) => a.id === reportAd.adId,
            );
            reportAd.adCreativeId = adEntity?.creative?.id || null;
        });

        await Promise.all(reportAds.map(async (reportAd) => {
            const creativeAsset = creativeAssets.find(
              (c: { id: string }) => c.id === reportAd.adCreativeId,
            );
            if (!creativeAsset) return;

            const {
                effective_instagram_media_id,
                effective_object_story_id,
                thumbnail_url,
                instagram_permalink_url
            } = creativeAsset;

            if (effective_instagram_media_id) {
                const igMedia = await api.getInstagramMedia(effective_instagram_media_id);
                reportAd.thumbnailUrl = igMedia.media_type === "IMAGE" && !igMedia.thumbnail_url
                    ? igMedia.media_url
                    : igMedia.thumbnail_url;
                reportAd.sourceUrl = igMedia.permalink;
            } else if (effective_object_story_id) {
                const postId = effective_object_story_id.split("_")[1];
                const post = await api.getPost(postId);
                reportAd.thumbnailUrl = post.adcreatives?.data?.[0]?.thumbnail_url || thumbnail_url || "";
                reportAd.sourceUrl = post.permalink_url || instagram_permalink_url || "";
            } else {
                reportAd.thumbnailUrl = thumbnail_url || "";
            }
        }));
        
        const finalFields = [...defaultAdKeys, ...selectedMetrics];
        reportAds.forEach((adObject: any) => {
            Object.keys(adObject).forEach((key: string) => {
                if (!finalFields.includes(key)) {
                    delete adObject[key];
                }
            });
        });

        return reportAds;
    }
}
