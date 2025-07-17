import axios, { type AxiosInstance } from "axios";
import { Database, OrganizationToken } from "marklie-ts-core";
import { Log } from "marklie-ts-core/dist/lib/classes/Logger.js";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("facebook-api");

export class FacebookApi {
  static readonly MAX_POLL_ATTEMPTS = 100;
  static readonly POLL_INTERVAL_MS = 6000;

  private api: AxiosInstance;

  private constructor(
    token: string,
    private accountId: string,
  ) {
    this.api = axios.create({
      baseURL: `https://graph.facebook.com/v22.0/`,
      params: { access_token: token },
    });
  }

  static async create(
    organizationUuid: string,
    accountId: string,
  ): Promise<FacebookApi> {
    const tokenRecord = await database.em.findOne(OrganizationToken, {
      organization: organizationUuid,
    });
    if (!tokenRecord)
      throw new Error(
        `No token found for organizationUuid ${organizationUuid}`,
      );
    return new FacebookApi(
      "EAASERizF7PoBO9DxAMbCWwZAJ4htpGSdj6kmRbdKBLLEiPrZC8bOtoXyoBiwNhq3POHk2rEVXRviwRE2gWYzFSVwvQMi2vZAZCB8bmvQbkZCEvyNWD2KpHcNoMEpWtvTo6NfZAG7IKivZA3ZCMzrxapNGQ4RHmQ6s4a333bEjZCZATlmEBzUQ05KMcJRHaEXGa",
      accountId,
    );
  }

  private async batchRequest(
    batch: { method: string; relative_url: string }[],
  ) {
    const res = await this.api.post("/", null, {
      params: { batch: JSON.stringify(batch) },
    });
    return res.data.map((item: any) => JSON.parse(item.body));
  }

  private async paginateAll<T = any>(
    endpoint: string,
    params: Record<string, any>,
  ): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = endpoint;
    let nextParams: Record<string, any> = { ...params };

    while (nextUrl) {
      const res: { data: { data?: T[]; paging?: { next?: string } } } =
        await this.api.get(nextUrl, {
          params: nextParams,
        });

      if (res.data.data) {
        results.push(...res.data.data);
      }

      const nextPage: string | undefined = res.data.paging?.next;
      if (nextPage) {
        const parsed: URL = new URL(nextPage);
        nextUrl = parsed.pathname;
        nextParams = Object.fromEntries(parsed.searchParams.entries());
      } else {
        nextUrl = null;
      }
    }

    return results;
  }

  public async getEntitiesBatch(entityIds: string[], fields: string[]) {
    const batch = entityIds.map((id) => ({
      method: "GET",
      relative_url: `${id}?fields=${fields.join(",")}`,
    }));
    return await this.batchRequest(batch);
  }

  public async getInsightsSmart(
    level: "account" | "campaign" | "adset" | "ad",
    fields: string[],
    options: {
      datePreset?: string;
      customDateRange?: { since: string; until: string };
      breakdowns?: string[];
      actionBreakdowns?: string[];
      timeIncrement?: number;
    } = {},
  ): Promise<any[]> {
    const {
      datePreset = "last_7d",
      customDateRange,
      breakdowns = [],
      actionBreakdowns = [],
      timeIncrement,
    } = options;

    const isLargeQuery =
      customDateRange ||
      breakdowns.length > 0 ||
      actionBreakdowns.length > 0 ||
      !["today", "yesterday", "last_7d"].includes(datePreset);

    const params: Record<string, any> = {
      fields: fields.join(","),
      level,
      ...(customDateRange
        ? { time_range: customDateRange }
        : { date_preset: datePreset }),
      __cppo: 1,
      ...(timeIncrement ? { time_increment: timeIncrement } : {}),
    };

    if (breakdowns.length) params.breakdowns = breakdowns.join(",");
    if (actionBreakdowns.length)
      params.action_breakdowns = actionBreakdowns.join(",");

    const endpoint = `${this.accountId}/insights`;

    logger.info(
      `Fetching insights: ${JSON.stringify({ endpoint, params, isLargeQuery })}`,
    );

    try {
      if (!isLargeQuery) {
        const res = await this.api.get(endpoint, {
          params: { ...params, limit: 100 },
        });
        return res.data.data || [];
      }

      return await this.fetchAsyncInsights(endpoint, params);
    } catch (error: any) {
      const fbMessage = error?.response?.data?.error?.message || "";
      const fbCode = error?.response?.data?.error?.code;

      const isRetryable =
        fbCode === 1 ||
        fbCode === 17 ||
        fbMessage.includes("reduce the amount of data");

      if (isRetryable) {
        logger.warn(
          `Retrying with async mode due to large query or throttling ${JSON.stringify(
            {
              fbCode,
              fbMessage,
            },
          )}`,
        );
        return await this.fetchAsyncInsights(endpoint, params);
      }

      throw error;
    }
  }

  private async fetchAsyncInsights(
    endpoint: string,
    params: Record<string, any>,
  ): Promise<any[]> {
    const jobRes = await this.api.post(endpoint, null, {
      params: { ...params, async: true },
    });

    const reportId = jobRes.data.report_run_id;
    logger.info(`Started async report fetch ${reportId}`);

    for (let i = 0; i < FacebookApi.MAX_POLL_ATTEMPTS; i++) {
      const statusRes = await this.api.get(`/${reportId}`);
      const status = statusRes.data.async_status;

      if (status === "Job Completed") {
        const dataRes = await this.api.get(`/${reportId}/insights`);
        return dataRes.data.data || [];
      }

      if (status === "Job Failed") {
        logger.error(`Facebook Insights async job failed ${reportId}`);
        throw new Error("Facebook Insights async job failed");
      }

      await new Promise((res) => setTimeout(res, FacebookApi.POLL_INTERVAL_MS));
    }

    logger.error(`Facebook Insights async job timed out ${reportId}`);
    throw new Error("Facebook Insights async job timed out");
  }

  public async getAdInsightsWithThumbnails(
    api: FacebookApi,
    fields: string[],
    datePreset: string,
  ): Promise<any[]> {
    const insights = await api.getInsightsSmart("ad", [...fields, "ad_id"], {
      datePreset,
      actionBreakdowns: ["action_type"],
    });

    const adIds = insights.reduce<string[]>((acc, i) => {
      if (i.ad_id) acc.push(i.ad_id);
      return acc;
    }, []);
    const ads = await api.getEntitiesBatch(adIds, ["id", "creative{id}"]);

    const creativeIds = ads
      .map((ad: { creative: { id: any } }) => ad.creative?.id)
      .filter((id: any): id is string => !!id);

    const creatives = await api.getEntitiesBatch(creativeIds, [
      "id",
      "thumbnail_url",
    ]);

    return insights.map((insight) => {
      const ad = ads.find((a: { id: any }) => a.id === insight.ad_id);
      const creative = creatives.find(
        (c: { id: any }) => c.id === ad?.creative?.id,
      );

      const getActionValue = (type: string) =>
        insight.actions?.find((a: any) => a.action_type === type)?.value ?? 0;

      return {
        ...insight,
        purchases: getActionValue("purchase"),
        addToCart: getActionValue("add_to_cart"),
        roas: insight.purchase_roas?.[0]?.value ?? 0,
        creative: {
          id: creative?.id ?? null,
          thumbnail_url: creative?.thumbnail_url ?? null,
        },
      };
    });
  }

  public async getAdCreatives(
    fields: string[] = [
      "id",
      "name",
      "object_story_id",
      "thumbnail_url",
      "effective_object_story_id",
    ],
  ) {
    return await this.paginateAll(`${this.accountId}/adcreatives`, {
      fields: fields.join(","),
      limit: 100,
    });
  }

  public async getCreativeAssetsBatch(creativeIds: string[]) {
    return await this.getEntitiesBatch(creativeIds, [
      "id",
      "effective_instagram_media_id",
      "effective_object_story_id",
      "thumbnail_url",
      "instagram_permalink_url",
    ]);
  }

  public async getInstagramMediaBatch(mediaIds: string[]) {
    return await this.getEntitiesBatch(mediaIds, [
      "media_url",
      "permalink",
      "thumbnail_url",
      "media_type",
    ]);
  }

  public async getCreativeAsset(
    creativeId: string,
    fields: string[] = [
      "id",
      "image_url",
      "thumbnail_url",
      "instagram_permalink_url",
      "effective_object_story_id",
    ],
  ) {
    const res = await this.api.get(`${creativeId}`, {
      params: { fields: fields.join(",") },
    });
    return res.data;
  }

  public async getInstagramMedia(
    mediaId: string,
    fields: string[] = [
      "media_url",
      "permalink",
      "thumbnail_url",
      "media_type",
    ],
  ) {
    const res = await this.api.get(`${mediaId}`, {
      params: { fields: fields.join(",") },
    });
    return res.data;
  }

  public async getProfile() {
    const res = await this.api.get(`/me`, {
      params: { fields: "id,name,email,picture" },
    });
    return res.data;
  }

  public async getBusinesses() {
    const res = await this.api.get(`/me/businesses`, {
      params: { fields: "id,name,owned_ad_accounts{id,name}", limit: 1000 },
    });
    return res.data;
  }

  public async getUserAdAccounts() {
    const res = await this.api.get(`/me/adaccounts`, {
      params: { fields: "id,name" },
    });
    return res.data;
  }

  public async getFilteredAdAccounts() {
    const businesses = await this.getBusinesses();
    const allAdAccounts = await this.getUserAdAccounts();
    const businessAccountIds = new Set<string>();
    for (const business of businesses.data) {
      const accounts = business.owned_ad_accounts?.data || [];
      accounts.forEach((acc: { id: string }) => businessAccountIds.add(acc.id));
    }
    return allAdAccounts.data.filter(
      (acc: any) => !businessAccountIds.has(acc.id),
    );
  }

  public async getRecommendations() {
    const res = await this.api.get(`${this.accountId}/recommendations`);
    return res.data;
  }

  public async getTargetingDemographics() {
    const res = await this.api.get(`${this.accountId}/reachestimate`, {
      params: {
        targeting_spec: JSON.stringify({
          geo_locations: { countries: ["US"] },
          age_min: 18,
          age_max: 65,
        }),
      },
    });
    return res.data;
  }

  public async getPost(postId: string) {
    const res = await this.api.get(`${this.accountId}`, {
      params: {
        fields:
          "id,name,adcreatives.limit(1){effective_object_story_id,name,thumbnail_url,authorization_category,instagram_permalink_url}",
        search: postId,
        limit: 1,
        thumbnail_height: 1080,
        thumbnail_width: 1080,
      },
    });
    return res.data;
  }
}
