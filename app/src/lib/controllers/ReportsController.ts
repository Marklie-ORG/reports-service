import Router from "koa-router";
import type { Context } from "koa";
import { ReportsService } from "../services/ReportsService.js";
import { User } from "marklie-ts-core";
import {
  AVAILABLE_ADS_METRICS,
  AVAILABLE_CAMPAIGN_METRICS,
  AVAILABLE_GRAPH_METRICS,
  AVAILABLE_KPI_METRICS,
  type ReportScheduleRequest,
  type SchedulingOptionMetrics,
  type SendAfterReviewRequest,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";

export class ReportsController extends Router {
  private readonly reportsService: ReportsService;
  constructor() {
    super({ prefix: "/api/reports" });
    this.reportsService = new ReportsService();
    this.setUpRoutes();
  }

  private setUpRoutes() {
    this.get("/available-metrics", this.getAvailableMetrics.bind(this));
    this.get("/:uuid", this.getReport.bind(this));
    this.get("/", this.getReports.bind(this));
    this.post("/schedule", this.scheduleReport.bind(this));
    this.post("/send-after-review", this.sendAfterReview.bind(this));
    this.get("/scheduling-option/:uuid", this.getSchedulingOption.bind(this));
    this.put(
      "/scheduling-option/:uuid",
      this.updateSchedulingOption.bind(this),
    );
    this.put(
      "/report-metrics-selections/:uuid",
      this.updateReportMetricsSelections.bind(this),
    );
  }

  private async getReport(ctx: Context) {
    const uuid = ctx.params.uuid as string;

    ctx.body = await this.reportsService.getReport(uuid);
    ctx.status = 200;
  }

  private async getReports(ctx: Context) {
    const user = ctx.state.user as User;

    ctx.body = await this.reportsService.getReports(
      user.activeOrganization.uuid,
    );
    ctx.status = 200;
  }

  private async scheduleReport(ctx: Context) {
    const user: User = ctx.state.user as User;
    const scheduleOption: ReportScheduleRequest = ctx.request
      .body as ReportScheduleRequest;

    const scheduleUuid: string | void =
      await this.reportsService.scheduleReport({
        ...scheduleOption,
        organizationUuid: user.activeOrganization.uuid,
      });

    ctx.body = {
      message: "Report schedule created successfully",
      uuid: scheduleUuid,
    };
    ctx.status = 201;
  }

  private async sendAfterReview(ctx: Context) {
    const body = ctx.request.body as SendAfterReviewRequest;

    const scheduleUuid: string | void =
      await this.reportsService.sendReportAfterReview(body.reportUuid);

    ctx.body = {
      message: "Report was saved and sent to the client",
      uuid: scheduleUuid,
    };
    ctx.status = 201;
  }

  private async updateSchedulingOption(ctx: Context) {
    const user: User = ctx.state.user as User;
    const scheduleOption: ReportScheduleRequest = ctx.request
      .body as ReportScheduleRequest;
    const uuid = ctx.params.uuid as string;

    await this.reportsService.updateSchedulingOption(uuid, {
      ...scheduleOption,
      organizationUuid: user.activeOrganization.uuid,
    });

    ctx.body = {
      message: "Report schedule updated successfully",
    };
    ctx.status = 200;
  }

  private async getSchedulingOption(ctx: Context) {
    const uuid = ctx.params.uuid as string;

    ctx.body = await this.reportsService.getSchedulingOption(uuid);
    ctx.status = 200;
  }

  private async getAvailableMetrics(ctx: Context) {
    ctx.body = {
      KPIs: Object.keys(AVAILABLE_KPI_METRICS),
      graphs: Object.keys(AVAILABLE_GRAPH_METRICS),
      ads: Object.keys(AVAILABLE_ADS_METRICS),
      campaigns: Object.keys(AVAILABLE_CAMPAIGN_METRICS),
    };
    ctx.status = 200;
  }

  private async updateReportMetricsSelections(ctx: Context) {
    const metricsSelections: SchedulingOptionMetrics = ctx.request
      .body as SchedulingOptionMetrics;
    const uuid = ctx.params.uuid as string;

    await this.reportsService.updateReportMetricsSelections(
      uuid,
      metricsSelections,
    );

    ctx.body = {
      message: "Report metrics selections updated successfully",
    };
    ctx.status = 200;
  }
}
