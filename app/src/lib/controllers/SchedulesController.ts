import Router from "koa-router";
import type { Context } from "koa";
import { MarklieError, User } from "marklie-ts-core";
import {
  AVAILABLE_ADS_METRICS,
  AVAILABLE_CAMPAIGN_METRICS,
  AVAILABLE_GRAPH_METRICS,
  AVAILABLE_KPI_METRICS,
  type ReportScheduleRequest,
  type SchedulingOptionMetrics,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import { SchedulesService } from "../services/SchedulesService.js";

export class SchedulesController extends Router {
  private readonly schedulesService: SchedulesService;
  constructor() {
    super({ prefix: "/api/scheduling-options" });
    this.schedulesService = new SchedulesService();
    this.setUpRoutes();
  }

  private setUpRoutes() {
    this.get("/available-metrics", this.getAvailableMetrics.bind(this));
    this.post("/schedule", this.scheduleReport.bind(this));
    this.get("/:uuid", this.getSchedulingOption.bind(this));
    this.get("/client/:clientUuid", this.getSchedulingOptions.bind(this));
    this.put("/:uuid", this.updateSchedulingOption.bind(this));
    this.put(
      "/report-metrics-selections/:uuid",
      this.updateReportMetricsSelections.bind(this),
    );
    this.delete("/:uuid", this.deleteSchedulingOption.bind(this));
    this.put("/:uuid/stop", this.stopSchedulingOption.bind(this));
  }

  private async scheduleReport(ctx: Context) {
    const user: User = ctx.state.user as User;
    const scheduleOption: ReportScheduleRequest = ctx.request
      .body as ReportScheduleRequest;

    const scheduleUuid: string | void =
      await this.schedulesService.scheduleReport({
        ...scheduleOption,
        organizationUuid: user.activeOrganization!.uuid,
      });

    if (!scheduleUuid) {
      throw MarklieError.internal(
        "Failed to create report schedule",
        undefined,
        "reports-service",
      );
    }

    ctx.body = {
      message: "Report schedule created successfully",
      uuid: scheduleUuid,
    };
    ctx.status = 201;
  }

  private async updateSchedulingOption(ctx: Context) {
    const user: User = ctx.state.user as User;
    const scheduleOption: ReportScheduleRequest = ctx.request
      .body as ReportScheduleRequest;
    const uuid = ctx.params.uuid as string;

    await this.schedulesService.updateSchedulingOption(uuid, {
      ...scheduleOption,
      organizationUuid: user.activeOrganization!.uuid,
    });

    ctx.body = {
      message: "Report schedule updated successfully",
    };
    ctx.status = 200;
  }

  private async getSchedulingOption(ctx: Context) {
    const uuid = ctx.params.uuid as string;

    ctx.body = await this.schedulesService.getSchedulingOption(uuid);
    ctx.status = 200;
  }

  private async getSchedulingOptions(ctx: Context) {
    const clientUuid = ctx.params.clientUuid as string;

    ctx.body = await this.schedulesService.getSchedulingOptions(clientUuid);
    ctx.status = 200;
  }

  private async getAvailableMetrics(ctx: Context) {
    ctx.body = {
      kpis: Object.keys(AVAILABLE_KPI_METRICS),
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

    await this.schedulesService.updateReportMetricsSelections(
      uuid,
      metricsSelections,
    );

    ctx.body = {
      message: "Report metrics selections updated successfully",
    };
    ctx.status = 200;
  }

  private async deleteSchedulingOption(ctx: Context) {
    const uuid = ctx.params.uuid as string;

    await this.schedulesService.deleteSchedulingOption(uuid);

    ctx.body = {
      message: "Report schedule deleted successfully",
    };
    ctx.status = 200;
  }

  private async stopSchedulingOption(ctx: Context) {
    const uuid = ctx.params.uuid as string;

    await this.schedulesService.stopSchedulingOption(uuid);

    ctx.body = {
      message: "Report schedule stopped (disabled) successfully",
    };
    ctx.status = 200;
  }
}
