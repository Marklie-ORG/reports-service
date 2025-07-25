import axios, { type AxiosError, type AxiosInstance } from "axios";
import {
  CircuitBreaker,
  CircuitBreakerManager,
  Database,
  MarklieError,
  OrganizationToken,
} from "marklie-ts-core";
import { Log } from "marklie-ts-core/dist/lib/classes/Logger.js";
import { ReportsConfigService } from "../config/config.js";

const database = await Database.getInstance();
const logger = Log.getInstance().extend("facebook-api");
const config = ReportsConfigService.getInstance();

export class FacebookApi {
  static readonly MAX_POLL_ATTEMPTS = 100;
  static readonly POLL_INTERVAL_MS = 6000;
  static readonly BATCH_SIZE = 50;
  static readonly MAX_RETRIES = 3;

  private circuitBreaker: CircuitBreaker;
  private api: AxiosInstance;

  private constructor(
    token: string,
    private accountId: string,
  ) {
    this.api = axios.create({
      baseURL: config.getFacebookApiUrl(),
      params: { access_token: token },
      timeout: 30000,
    });

    this.circuitBreaker = CircuitBreakerManager.getInstance().getOrCreate(
      "FacebookAPI",
      {
        failureThreshold: 5,
        recoveryTimeout: 60000,
        expectedErrorCodes: ["VALIDATION_ERROR"],
      },
    );

    this.setupInterceptors();
  }

  static async create(
    organizationUuid: string,
    accountId?: string,
  ): Promise<FacebookApi> {
    const tokenRecord = await database.em.findOne(OrganizationToken, {
      organization: organizationUuid,
    });
    if (!tokenRecord)
      throw new Error(
        `No token found for organizationUuid ${organizationUuid}`,
      );
    return new FacebookApi(tokenRecord.token, accountId ?? "");
  }

  private setupInterceptors() {
    this.api.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        const fbError = error.response?.data as any;
        const fbCode = fbError?.error?.code;
        const fbMessage = fbError?.error?.message || "";

        logger.error("Facebook API Error:", {
          status: error.response?.status,
          fbCode,
          fbMessage,
          url: error.config?.url,
        });

        switch (fbCode) {
          case 190:
            throw MarklieError.unauthorized(
              "Facebook access token is invalid",
              "facebook-api",
            );
          case 100:
            throw MarklieError.validation(
              `Facebook API validation error: ${fbMessage}`,
              { fbCode },
            );
          default:
            throw MarklieError.externalApi(
              "Facebook API",
              error,
              "facebook-api",
            );
        }
      },
    );
  }

  private async executeWithCircuitBreaker<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.circuitBreaker.execute(operation);
  }

  private async retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries: number = FacebookApi.MAX_RETRIES,
    delay: number = 1000,
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (
          error instanceof MarklieError &&
          error.statusCode >= 400 &&
          error.statusCode < 500
        ) {
          throw error;
        }

        if (attempt === maxRetries) {
          break;
        }

        const backoffDelay = delay * Math.pow(2, attempt - 1);
        logger.warn(
          `Facebook API retry ${attempt}/${maxRetries} after ${backoffDelay}ms`,
          {
            error: error instanceof Error ? error.message : "Unknown error",
          },
        );

        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      }
    }

    throw lastError!;
  }

  private async batchRequest(
    batch: { method: string; relative_url: string }[],
  ): Promise<any[]> {
    if (batch.length === 0) return [];

    const batches = this.chunkArray(batch, FacebookApi.BATCH_SIZE);
    const results: any[] = [];

    for (const batchChunk of batches) {
      const batchResult = await this.executeWithCircuitBreaker(async () => {
        const res = await this.api.post("/", null, {
          params: { batch: JSON.stringify(batchChunk) },
        });

        return res.data.map((item: any) => {
          if (item.code !== 200) {
            logger.warn(`Batch request item failed: `, {
              code: item.code,
              body: item.body,
            });
            return null;
          }
          return JSON.parse(item.body);
        });
      });

      results.push(...batchResult);
    }

    return results.filter(Boolean);
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private async paginateAll<T = any>(
    endpoint: string,
    params: Record<string, any>,
    maxPages: number = 100,
  ): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = endpoint;
    let nextParams: Record<string, any> = { ...params };
    let pageCount = 0;

    while (nextUrl && pageCount < maxPages) {
      const pageData = await this.executeWithCircuitBreaker(async () => {
        const res = await this.api.get(nextUrl!, { params: nextParams });
        return res.data;
      });

      if (pageData.data) {
        results.push(...pageData.data);
      }

      const nextPage = pageData.paging?.next;
      if (nextPage) {
        const parsed = new URL(nextPage);
        nextUrl = parsed.pathname;
        nextParams = Object.fromEntries(parsed.searchParams.entries());
        pageCount++;
      } else {
        nextUrl = null;
      }
    }

    if (pageCount >= maxPages) {
      logger.warn(`Pagination stopped at maximum pages: ${maxPages}`, {
        endpoint,
        resultsCount: results.length,
      });
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
      additionalFields?: string[];
    } = {},
  ): Promise<any[]> {
    const {
      datePreset = "last_7d",
      customDateRange,
      breakdowns = [],
      actionBreakdowns = [],
      timeIncrement,
      additionalFields = [],
    } = options;

    if (!fields.length) {
      throw MarklieError.validation(
        "At least one field is required for insights",
      );
    }

    const isLargeQuery =
      customDateRange ||
      breakdowns.length > 0 ||
      actionBreakdowns.length > 0 ||
      !["today", "yesterday", "last_7d"].includes(datePreset);

    const params: Record<string, any> = {
      fields: Array.from(new Set(fields)).join(","),
      level,
      ...(customDateRange
        ? { time_range: customDateRange }
        : { date_preset: datePreset }),
      __cppo: 1,
      ...(timeIncrement ? { time_increment: timeIncrement } : {}),
      ...(additionalFields ? { additionalFields: additionalFields } : {}),
    };

    if (breakdowns.length) params.breakdowns = breakdowns.join(",");
    if (actionBreakdowns.length)
      params.action_breakdowns = actionBreakdowns.join(",");

    const endpoint = `${this.accountId}/insights`;

    logger.info("Fetching Facebook insights", {
      endpoint,
      level,
      fields: fields.length,
      isLargeQuery,
      datePreset: customDateRange ? "custom" : datePreset,
    });

    try {
      if (!isLargeQuery) {
        return await this.executeWithCircuitBreaker(async () => {
          const res = await this.api.get(endpoint, {
            params: { ...params, limit: 100 },
          });
          return res.data.data || [];
        });
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
          `Retrying with async mode due to large query or throttling`,
          { fbCode, fbMessage },
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
    const jobRes = await this.executeWithCircuitBreaker(async () => {
      console.log(endpoint, params.fields);
      return this.api.post(endpoint, null, {
        params: { ...params, async: true },
      });
    });

    const reportId = jobRes.data.report_run_id;
    if (!reportId) {
      throw MarklieError.externalApi(
        "Facebook API did not return report_run_id",
      );
    }

    logger.info(`Started async Facebook insights job: ${reportId}`);

    let pollInterval = FacebookApi.POLL_INTERVAL_MS;

    for (let attempt = 1; attempt <= FacebookApi.MAX_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));

      const statusRes = await this.executeWithCircuitBreaker(async () => {
        return this.api.get(`/${reportId}`);
      });

      const status = statusRes.data.async_status;
      const progress = statusRes.data.async_percent_completion || 0;

      logger.debug(
        `Facebook insights job ${reportId} status: ${status} (${progress}%)`,
      );

      switch (status) {
        case "Job Completed":
          const dataRes = await this.executeWithCircuitBreaker(async () => {
            return this.api.get(`/${reportId}/insights`);
          });
          logger.info(
            `Facebook insights job ${reportId} completed successfully`,
          );
          return dataRes.data.data || [];

        case "Job Failed":
          logger.error(`Facebook insights job ${reportId} failed`);
          throw MarklieError.externalApi("Facebook Insights async job failed");

        case "Job Running":
        case "Job Started":
          if (attempt > 10) {
            pollInterval = Math.min(pollInterval * 1.2, 15000);
          }
          break;

        default:
          logger.warn(`Unknown Facebook insights job status: ${status}`);
      }
    }

    logger.error(
      `Facebook insights job ${reportId} timed out after ${FacebookApi.MAX_POLL_ATTEMPTS} attempts`,
    );
    throw MarklieError.externalApi("Facebook Insights async job timed out");
  }

  public async getAdInsightsWithThumbnails(
    fields: string[],
    datePreset: string,
  ): Promise<any[]> {
    const insights = await this.getInsightsSmart("ad", [...fields, "ad_id"], {
      datePreset,
      actionBreakdowns: ["action_type"],
    });

    if (insights.length === 0) {
      logger.info("No ad insights data returned");
      return [];
    }

    return await this.enrichInsightsWithCreativeData(insights);
  }

  private async enrichInsightsWithCreativeData(
    insights: any[],
  ): Promise<any[]> {
    const adIds = insights
      .map((insight) => insight.ad_id)
      .filter((id): id is string => !!id);

    if (adIds.length === 0) return insights;

    try {
      const adFields = ["id", "creative{id}"];

      const ads = await this.getEntitiesBatch(adIds, adFields);

      const creativeIds = ads
        .map((ad) => ad.creative?.id)
        .filter((id): id is string => !!id);

      const creatives =
        creativeIds.length > 0
          ? await this.getEntitiesBatch(creativeIds, ["id", "thumbnail_url"])
          : [];

      return insights.map((insight) => {
        const ad = ads.find((a) => a.id === insight.ad_id);
        const creative = creatives.find((c) => c.id === ad?.creative?.id);

        const getActionValue = (type: string) =>
          insight.actions?.find((a: any) => a.action_type === type)?.value ?? 0;

        return {
          ...insight,
          purchases: getActionValue("purchase"),
          addToCart: getActionValue("add_to_cart"),
          roas: insight.purchase_roas?.[0]?.value ?? 0,
          ad_name: insight?.ad_name ?? null,
          creative: {
            id: creative?.id ?? null,
            thumbnail_url: creative?.thumbnail_url ?? null,
          },
        };
      });
    } catch (error) {
      logger.error("Error enriching insights with creative data:", error);
      return insights;
    }
  }

  public async getAdCreatives(
    fields: string[] = [
      "id",
      "name",
      "object_story_id",
      "thumbnail_url",
      "effective_object_story_id",
    ],
  ): Promise<any[]> {
    return await this.retryOperation(() =>
      this.paginateAll(`${this.accountId}/adcreatives`, {
        fields: fields.join(","),
        limit: 100,
      }),
    );
  }

  public async getCreativeAssetsBatch(creativeIds: string[]): Promise<any[]> {
    return await this.getEntitiesBatch(creativeIds, [
      "id",
      "effective_instagram_media_id",
      "effective_object_story_id",
      "thumbnail_url",
      "instagram_permalink_url",
    ]);
  }

  public async getInstagramMediaBatch(mediaIds: string[]): Promise<any[]> {
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
  ): Promise<any> {
    return await this.executeWithCircuitBreaker(async () => {
      const res = await this.api.get(`${creativeId}`, {
        params: { fields: fields.join(",") },
      });
      return res.data;
    });
  }

  public async getInstagramMedia(
    mediaId: string,
    fields: string[] = [
      "media_url",
      "permalink",
      "thumbnail_url",
      "media_type",
    ],
  ): Promise<any> {
    return await this.executeWithCircuitBreaker(async () => {
      const res = await this.api.get(`${mediaId}`, {
        params: { fields: fields.join(",") },
      });
      return res.data;
    });
  }

  public async getProfile() {
    const res = await this.api.get(`/me`, {
      params: { fields: "id,name,email,picture" },
    });
    return res.data;
  }

  public async getBusinesses(): Promise<any> {
    return await this.executeWithCircuitBreaker(async () => {
      const res = await this.api.get(`/me/businesses`, {
        params: { fields: "id,name,owned_ad_accounts{id,name}", limit: 1000 },
      });
      return res.data;
    });
  }

  public async getUserAdAccounts(): Promise<any> {
    return await this.executeWithCircuitBreaker(async () => {
      const res = await this.api.get(`/me/adaccounts`, {
        params: { fields: "id,name" },
      });
      return res.data;
    });
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

  public async getPost(postId: string): Promise<any> {
    return await this.executeWithCircuitBreaker(async () => {
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
    });
  }

  public async getCustomMetricsForAdAccounts(
    adAccountIds: string[],
  ): Promise<Record<string, { id: string; name: string }[]>> {
    const result: Record<string, { id: string; name: string }[]> = {};

    await Promise.all(
      adAccountIds.map(async (adAccountId) => {
        try {
          const conversionsRes = await this.api.get(
            `${adAccountId}/customconversions`,
          );
          const conversions = conversionsRes.data.data ?? [];

          if (conversions.length === 0) return;

          const details: { id: string; name: string }[] = [];

          await Promise.allSettled(
            conversions.map((cc: any) =>
              this.api
                .get(`${cc.id}`, {
                  params: {
                    fields: "name,custom_event_type,description,rule",
                  },
                })
                .then((res) => {
                  const data = res?.data;
                  if (data?.id && data?.name) {
                    details.push({ id: data.id, name: data.name });
                  }
                }),
            ),
          );

          if (details.length > 0) {
            result[adAccountId] = details;
          }
        } catch (err) {
          console.warn(
            `Error fetching custom conversions for ${adAccountId}`,
            err,
          );
        }
      }),
    );

    return result;
  }
}
