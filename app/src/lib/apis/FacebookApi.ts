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

const logger = Log.getInstance().extend("facebook-api");
const config = ReportsConfigService.getInstance();

export class FacebookApi {
  static readonly MAX_POLL_ATTEMPTS = 60;
  static readonly POLL_INTERVAL_MS = 8000;
  static readonly BATCH_SIZE = 50;
  static readonly MAX_RETRIES = 3;
  private accountId: string = "";
  private organizationUuid: string = "";

  private circuitBreaker: CircuitBreaker;
  private api: AxiosInstance;

  private managedPagesPromise?: Promise<
    Array<{ id: string; name: string; access_token: string }>
  >;

  private constructor(token: string, orgUuid: string, accountId?: string) {
    this.organizationUuid = orgUuid;
    this.accountId = accountId ?? "";
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

  public getOrganizationUuid(): string {
    return this.organizationUuid;
  }

  static async create(
    organizationUuid: string,
    accountId?: string,
  ): Promise<FacebookApi> {
    const database = await Database.getInstance();
    const tokenRecord = await database.em.findOne(OrganizationToken, {
      organization: organizationUuid,
    });
    if (!tokenRecord)
      throw new Error(
        `No token found for organizationUuid ${organizationUuid}`,
      );
    return new FacebookApi(tokenRecord.token, organizationUuid, accountId);
  }

  private setupInterceptors() {
    this.api.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        const fbError = error.response?.data as any;
        const fbCode = fbError?.error?.code;
        const fbSub = fbError?.error?.error_subcode;
        const fbMessage = fbError?.error?.message || "";

        logger.error("Facebook API Error:", {
          status: error.response?.status,
          fbCode,
          fbSub,
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
              { fbCode, fbSub },
            );
          case 4:
            throw MarklieError.externalApi(
              "Facebook API rate limit",
              error,
              "facebook-api",
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

  // private async retryOperation<T>(
  //   operation: () => Promise<T>,
  //   maxRetries: number = FacebookApi.MAX_RETRIES,
  //   delay: number = 1000,
  // ): Promise<T> {
  //   let lastError: Error;
  //
  //   for (let attempt = 1; attempt <= maxRetries; attempt++) {
  //     try {
  //       return await operation();
  //     } catch (error) {
  //       lastError = error as Error;
  //
  //       if (
  //         error instanceof MarklieError &&
  //         error.statusCode >= 400 &&
  //         error.statusCode < 500
  //       ) {
  //         throw error;
  //       }
  //
  //       if (attempt === maxRetries) {
  //         break;
  //       }
  //
  //       const backoffDelay = delay * Math.pow(2, attempt - 1);
  //       logger.warn(
  //         `Facebook API retry ${attempt}/${maxRetries} after ${backoffDelay}ms`,
  //         {
  //           error: error instanceof Error ? error.message : "Unknown error",
  //         },
  //       );
  //
  //       await new Promise((resolve) => setTimeout(resolve, backoffDelay));
  //     }
  //   }
  //
  //   throw lastError!;
  // }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
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
          try {
            return JSON.parse(item.body);
          } catch {
            return item.body;
          }
        });
      });

      results.push(...batchResult);
    }

    return results.filter(Boolean);
  }

  private async batchRequestWithToken(
    batch: { method: string; relative_url: string }[],
    token: string,
  ): Promise<any[]> {
    if (batch.length === 0) return [];

    const batches = this.chunkArray(batch, FacebookApi.BATCH_SIZE);
    const results: any[] = [];

    for (const batchChunk of batches) {
      const batchResult = await this.executeWithCircuitBreaker(async () => {
        const res = await this.api.post("/", null, {
          params: { batch: JSON.stringify(batchChunk), access_token: token },
        });

        return res.data.map((item: any) => {
          if (item.code !== 200) {
            logger.warn("Batch request item failed:", {
              code: item.code,
              body: item.body,
            });
            return null;
          }
          try {
            return JSON.parse(item.body);
          } catch {
            return item.body;
          }
        });
      });

      results.push(...batchResult);
    }

    return results.filter(Boolean);
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

  private containsReachFields(fields: string[]): boolean {
    const set = new Set(fields.map((f) => f.toLowerCase()));
    return set.has("reach") || set.has("frequency") || set.has("cpp");
  }

  // private static monthsBetween(startISO: string, endISO: string): number {
  //   const s = new Date(startISO);
  //   const e = new Date(endISO);
  //   const months =
  //     (e.getUTCFullYear() - s.getUTCFullYear()) * 12 +
  //     (e.getUTCMonth() - s.getUTCMonth());
  //   return months + (e.getUTCDate() >= s.getUTCDate() ? 0 : -1);
  // }

  private adaptPollInterval(prev: number, utilPct?: number): number {
    if (typeof utilPct === "number" && utilPct >= 80) {
      return Math.min(prev * 1.5, 20000);
    }
    return Math.min(prev * 1.15, 15000);
  }

  public async getManagedPages(): Promise<
    Array<{ id: string; name: string; access_token: string }>
  > {
    if (!this.managedPagesPromise) {
      this.managedPagesPromise = (async () => {
        const pages = await this.paginateAll<{
          id: string;
          name: string;
          access_token: string;
        }>("/me/accounts", { fields: "id,name,access_token", limit: 100 });
        return pages
          .filter((p) => p?.id && p?.name && p?.access_token)
          .map((p) => ({
            id: p.id,
            name: p.name,
            access_token: p.access_token,
          }));
      })();
    }
    return this.managedPagesPromise;
  }

  public async getEntitiesBatch(entityIds: string[], fields: string[]) {
    const batch = entityIds.map((id) => ({
      method: "GET",
      relative_url: `${encodeURIComponent(id)}?fields=${encodeURIComponent(fields.join(","))}`,
    }));
    return await this.batchRequest(batch);
  }

  public async getEntitiesBatchWithToken(
    token: string,
    ids: string[],
    fields: string[],
  ): Promise<any[]> {
    if (!ids?.length) return [];
    const batch = ids.map((id) => ({
      method: "GET",
      relative_url: `${encodeURIComponent(id)}?fields=${encodeURIComponent(fields.join(","))}`,
    }));
    return this.batchRequestWithToken(batch, token);
  }

  public async getInstagramMediaBatchWithToken(
    token: string,
    mediaIds: string[],
    fields: string[],
  ): Promise<any[]> {
    if (!mediaIds?.length) return [];
    const batch = mediaIds.map((id) => ({
      method: "GET",
      relative_url: `${encodeURIComponent(id)}?fields=${encodeURIComponent(fields.join(","))}`,
    }));
    return this.batchRequestWithToken(batch, token);
  }

  public async getInsightsSmart(
    level: "account" | "campaign" | "adset" | "ad",
    fields: string[],
    options: {
      datePreset?: string;
      customDateRange?: { since: string; until: string };
      breakdowns?: string[];
      actionBreakdowns?: string[];
      timeIncrement?: number | "all_days";
      additionalFields?: string[];
    } = {},
  ): Promise<any[]> {
    const {
      datePreset = "last_7d",
      customDateRange,
      breakdowns = [],
      actionBreakdowns = [],
      timeIncrement,
    } = options;

    if (!fields.length) {
      throw MarklieError.validation(
        "At least one field is required for insights",
      );
    }

    const params: Record<string, any> = {
      fields: Array.from(new Set(fields)).join(","),
      level,
      ...(customDateRange
        ? { time_range: customDateRange }
        : { date_preset: datePreset }),
      __cppo: 1,
      ...(timeIncrement !== undefined ? { time_increment: timeIncrement } : {}),
      limit: 500,
    };

    if (breakdowns.length) params.breakdowns = breakdowns.join(",");
    if (actionBreakdowns.length)
      params.action_breakdowns = actionBreakdowns.join(",");

    const endpoint = `${this.accountId}/insights`;

    // Allow sync when custom range + all_days + no breakdowns; async otherwise
    const isLargeQuery =
      breakdowns.length > 0 ||
      actionBreakdowns.length > 0 ||
      (customDateRange
        ? timeIncrement !== "all_days"
        : !["today", "yesterday", "last_7d"].includes(datePreset));

    logger.info("Fetching Facebook insights", {
      endpoint,
      level,
      fields: fields.length,
      mode: isLargeQuery ? "async" : "sync",
      datePreset: customDateRange ? "custom" : datePreset,
      breakdowns: breakdowns.join(",") || "none",
    });

    try {
      if (isLargeQuery) {
        return await this.paginateAll<any>(endpoint, params, 1000);
      }

      return await this.fetchAsyncInsights(
        endpoint,
        params,
        this.containsReachFields(fields),
      );
    } catch (error: any) {
      const msg: string =
        error?.data?.error?.message ||
        error?.response?.data?.error?.message ||
        "";

      const reachThrottle =
        /Reach-related metric breakdowns are unavailable/i.test(msg) ||
        /reach.*unavailable.*rate limit/i.test(msg);

      if (reachThrottle) {
        const cleaned = fields.filter(
          (f) => !["reach", "frequency", "cpp"].includes(f.toLowerCase()),
        );
        if (!cleaned.length) return [];
        logger.warn(
          "Retrying insights without reach-related fields due to throttle",
        );
        return this.getInsightsSmart(level, cleaned, options);
      }

      const fbCode = error?.response?.data?.error?.code;
      const fbSub = error?.response?.data?.error?.error_subcode;
      if (fbCode === 100 && fbSub === 1487534) {
        logger.warn("Data-per-call limit. Falling back to async job.");
        return await this.fetchAsyncInsights(
          endpoint,
          params,
          this.containsReachFields(fields),
        );
      }

      throw error;
    }
  }

  private async fetchAsyncInsights(
    endpoint: string,
    params: Record<string, any>,
    reachAware: boolean = false,
  ): Promise<any[]> {
    const jobRes = await this.executeWithCircuitBreaker(async () => {
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

      let appUtilPct: number | undefined = undefined;
      const throttleHdr = (statusRes.headers?.["x-fb-ads-insights-throttle"] ||
        statusRes.headers?.["X-FB-ADS-INSIGHTS-THROTTLE"]) as
        | string
        | undefined;
      if (throttleHdr) {
        try {
          const parsed = JSON.parse(String(throttleHdr));
          appUtilPct = Number(parsed?.app_id_util_pct);
        } catch {}
      }

      logger.debug(
        `Facebook insights job ${reportId} status: ${status} (${progress}%)`,
      );

      switch (status) {
        case "Job Completed": {
          const dataRes = await this.executeWithCircuitBreaker(async () => {
            return this.api.get(`/${reportId}/insights`);
          });
          logger.info(
            `Facebook insights job ${reportId} completed successfully`,
          );
          return dataRes.data.data || [];
        }
        case "Job Failed": {
          if (reachAware) {
            logger.warn(
              "Async job failed. Retrying without reach-related fields.",
            );
            const filtered = { ...params };
            const list = String(filtered.fields)
              .split(",")
              .filter(
                (f) => !["reach", "frequency", "cpp"].includes(f.toLowerCase()),
              );
            if (!list.length)
              throw MarklieError.externalApi(
                "Facebook Insights async job failed",
              );
            filtered.fields = list.join(",");
            return await this.fetchAsyncInsights(endpoint, filtered, false);
          }
          logger.error(`Facebook insights job ${reportId} failed`);
          throw MarklieError.externalApi("Facebook Insights async job failed");
        }
        case "Job Running":
        case "Job Started": {
          pollInterval = this.adaptPollInterval(pollInterval, appUtilPct);
          break;
        }
        default:
          logger.warn(`Unknown Facebook insights job status: ${status}`);
          pollInterval = this.adaptPollInterval(pollInterval, appUtilPct);
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
      datePreset: datePreset,
      actionBreakdowns: ["action_type"],
    });

    if (insights.length === 0) return [];

    return await this.enrichInsightsWithCreativeData(insights);
  }

  private async enrichInsightsWithCreativeData(
    insights: any[],
  ): Promise<any[]> {
    if (!Array.isArray(insights) || insights.length === 0) return insights;

    // 1) fetch ads -> creatives
    const adIds = insights.map((i) => i.ad_id).filter(Boolean);
    if (!adIds.length) return insights;

    const adFields = [
      "id",
      "name",
      "creative{id,thumbnail_url,instagram_permalink_url,effective_instagram_media_id,effective_object_story_id}",
    ];
    const ads = await this.getEntitiesBatch(adIds, adFields);

    // 2) collect IG media ids and FB story ids per page for later enrichment
    const creativeByAdId = new Map<string, any>();
    const igMediaIds = new Set<string>();
    const storyIdsByPage = new Map<string, string[]>();

    for (const ad of ads) {
      const cr = ad?.creative || {};
      creativeByAdId.set(ad.id, cr);

      const mediaId: string | undefined = cr.effective_instagram_media_id;
      if (mediaId) igMediaIds.add(mediaId);

      const storyId: string | undefined = cr.effective_object_story_id;
      const pageId = this.extractPageIdFromStoryId(storyId);
      if (pageId && storyId) {
        if (!storyIdsByPage.has(pageId)) storyIdsByPage.set(pageId, []);
        storyIdsByPage.get(pageId)!.push(storyId);
      }
    }

    // 3) load page tokens
    const managedPages = await this.getManagedPages();
    const tokenByPage = new Map(
      managedPages.map((p: any) => [p.id, p.access_token]),
    );
    const firstPageToken = managedPages[0]?.access_token;

    // 4) fetch IG media for large assets
    const igById = new Map<string, any>();
    if (igMediaIds.size && firstPageToken) {
      try {
        const ig = await this.getInstagramMediaBatchWithToken(
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
        for (const m of ig ?? []) igById.set(m.id, m);
      } catch {}
    }

    // 5) fetch FB posts for story ids
    const postById = new Map<string, any>();
    for (const [pageId, storyIds] of storyIdsByPage) {
      const token = tokenByPage.get(pageId);
      if (!token) continue;
      const unique = [...new Set(storyIds)];
      try {
        const posts = await this.getEntitiesBatchWithToken(token, unique, [
          "id",
          "permalink_url",
          "full_picture",
          "attachments{media_type,media,url,subattachments{media_type,media,url}}",
        ]);
        for (const p of posts ?? []) postById.set(p.id, p);
      } catch {}
    }

    const getActionValue = (ins: any, type: string) =>
      ins.actions?.find((a: any) => a.action_type === type)?.value ?? 0;

    // 6) build enriched insights
    return insights.map((ins) => {
      const ad = ads.find((a: any) => a.id === ins.ad_id);
      const cr = ad?.creative || {};

      // choose best thumbnail + permalink
      let thumbnail_url = cr?.thumbnail_url ?? null;
      let permalink = cr?.instagram_permalink_url ?? null;

      // IG first
      if (cr?.effective_instagram_media_id) {
        const media = igById.get(cr.effective_instagram_media_id);
        if (media) {
          if (
            media.media_type === "CAROUSEL_ALBUM" &&
            media.children?.data?.length
          ) {
            const first = media.children.data[0];
            thumbnail_url =
              (first.media_type === "IMAGE" && !first.thumbnail_url
                ? first.media_url
                : first.thumbnail_url) || thumbnail_url;
            permalink = first.permalink || media.permalink || permalink;
          } else {
            thumbnail_url =
              (media.media_type === "IMAGE" && !media.thumbnail_url
                ? media.media_url
                : media.thumbnail_url) || thumbnail_url;
            permalink = media.permalink || permalink;
          }
        }
      }

      // FB fallback
      if ((!thumbnail_url || !permalink) && cr?.effective_object_story_id) {
        const post = postById.get(cr.effective_object_story_id);
        if (post) {
          const fromAttachments = (att: any): string | null => {
            const first = att?.data?.[0];
            return (
              first?.media?.image?.src ||
              first?.media?.source ||
              first?.media?.src ||
              first?.url ||
              first?.subattachments?.data?.[0]?.media?.image?.src ||
              first?.subattachments?.data?.[0]?.media?.source ||
              first?.subattachments?.data?.[0]?.media?.src ||
              first?.subattachments?.data?.[0]?.url ||
              null
            );
          };
          thumbnail_url =
            fromAttachments(post.attachments) ||
            post.full_picture ||
            thumbnail_url;
          permalink = post.permalink_url || permalink;
        }
      }

      // custom conversions aggregation
      const customConversions: Record<string, number> = {};
      const customConversionValues: Record<string, number> = {};

      if (Array.isArray(ins.actions)) {
        for (const a of ins.actions) {
          const t = a?.action_type ?? "";
          const m = /^offsite_conversion\.custom\.(\d+)$/.exec(t);
          if (m) {
            const id = m[1];
            customConversions[id] =
              (customConversions[id] ?? 0) + Number(a.value ?? 0);
          }
        }
      }
      if (Array.isArray(ins.action_values)) {
        for (const av of ins.action_values) {
          const t = av?.action_type ?? "";
          const m = /^offsite_conversion\.custom\.(\d+)$/.exec(t);
          if (m) {
            const id = m[1];
            customConversionValues[id] =
              (customConversionValues[id] ?? 0) + Number(av.value ?? 0);
          }
        }
      }

      return {
        ...ins,
        purchases: getActionValue(ins, "purchase"),
        addToCart: getActionValue(ins, "add_to_cart"),
        roas: ins.purchase_roas?.[0]?.value ?? 0,
        ad_name: ins?.ad_name ?? null,
        creative: {
          id: cr?.id ?? null,
          thumbnail_url,
          instagram_permalink_url: permalink,
          effective_instagram_media_id:
            cr?.effective_instagram_media_id ?? null,
          effective_object_story_id: cr?.effective_object_story_id ?? null,
        },
        customConversions,
        customConversionValues,
      };
    });
  }

  private extractPageIdFromStoryId(storyId?: string): string | null {
    if (!storyId) return null;
    const m = String(storyId).match(/^(\d+)_\d+$/);
    return m ? m[1] : null;
  }

  public async listCustomConversions(
    adAccountId: string,
    opts: { includeArchived?: boolean; pageLimit?: number } = {},
  ): Promise<
    Array<{
      id: string;
      name: string;
      custom_event_type?: string;
      rule?: any;
      is_archived?: boolean;
    }>
  > {
    const params = {
      fields: "id,name",
      include_archived: !!opts.includeArchived,
      limit: opts.pageLimit ?? 200,
    };

    return await this.paginateAll<{
      id: string;
      name: string;
      custom_event_type?: string;
      rule?: any;
      is_archived?: boolean;
    }>(`${adAccountId}/customconversions`, params);
  }

  public async getCustomConversionsForAdAccounts(
    adAccountIds: string[],
    opts: { includeArchived?: boolean; pageLimit?: number } = {},
  ): Promise<
    Record<
      string,
      Array<{
        id: string;
        name: string;
        custom_event_type?: string;
        rule?: any;
        is_archived?: boolean;
      }>
    >
  > {
    const out: Record<
      string,
      Array<{
        id: string;
        name: string;
        custom_event_type?: string;
        rule?: any;
        is_archived?: boolean;
      }>
    > = {};

    await Promise.all(
      adAccountIds.map(async (actId) => {
        try {
          const rows = await this.listCustomConversions(actId, opts);
          if (rows.length) out[actId] = rows;
        } catch (err) {
          logger.warn("Failed to list custom conversions for ad account", {
            actId,
            err: (err as Error).message,
          });
        }
      }),
    );

    return out;
  }
}
