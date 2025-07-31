import Router from "koa-router";
import type { Context } from "koa";
import { MarklieError, User } from "marklie-ts-core";
import type {
  ReportScheduleRequest,
  ScheduleBulkActionRequest,
  SchedulingOptionMetrics,
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
    this.get("/available-metrics/:uuid", this.getAvailableMetrics.bind(this));
    this.post("/schedule", this.scheduleReport.bind(this));

    this.get("/client/:clientUuid", this.getSchedulingOptions.bind(this));
    this.put(
      "/report-metrics-selections/:uuid",
      this.updateReportMetricsSelections.bind(this),
    );
    this.put("/stop", this.stopSchedulingOptions.bind(this));
    this.put("/delete", this.deleteSchedulingOption.bind(this));
    this.put("/activate", this.activateSchedulingOption.bind(this));

    this.get("/:uuid", this.getSchedulingOption.bind(this));
    this.put("/:uuid", this.updateSchedulingOption.bind(this));
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
    console.log(ctx.params.uuid);

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
    console.log("das", uuid);

    ctx.body = await this.schedulesService.getSchedulingOption(uuid);
    ctx.status = 200;
  }

  private async getSchedulingOptions(ctx: Context) {
    const clientUuid = ctx.params.clientUuid as string;

    ctx.body = await this.schedulesService.getSchedulingOptions(clientUuid);
    ctx.status = 200;
  }

  private async getAvailableMetrics(ctx: Context) {
    const clientUuid = ctx.params.uuid as string;

    ctx.body =
      await this.schedulesService.getAvailableMetricsForAdAccounts(clientUuid);
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
    const body = ctx.request.body as ScheduleBulkActionRequest;

    await this.schedulesService.deleteSchedulingOptions(body.uuids);

    ctx.body = {
      message: "Report schedule deleted successfully",
    };
    ctx.status = 200;
  }

  private async stopSchedulingOptions(ctx: Context) {
    const body = ctx.request.body as ScheduleBulkActionRequest;

    await this.schedulesService.stopSchedulingOptions(body.uuids);

    ctx.body = {
      message: "Report schedule stopped (disabled) successfully",
    };
    ctx.status = 200;
  }

  private async activateSchedulingOption(ctx: Context) {
    const body = ctx.request.body as ScheduleBulkActionRequest;

    await this.schedulesService.activateSchedulingOptions(body.uuids);

    ctx.body = {
      message: "Report schedule deleted successfully",
    };
    ctx.status = 200;
  }
}
