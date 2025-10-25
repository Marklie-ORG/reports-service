import Router from "koa-router";
import type { Context } from "koa";
import { MarklieError, User } from "marklie-ts-core";
import { SchedulesService } from "../services/SchedulesService.js";
import type {
  ReportScheduleRequest,
  ScheduleBulkActionRequest,
} from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

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

    this.put("/stop", this.stopSchedulingOptions.bind(this));
    this.put("/delete", this.deleteSchedulingOption.bind(this));
    this.put("/activate", this.activateSchedulingOptions.bind(this));

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
    const clientUuid = ctx.params.uuid as string;

    ctx.body =
      await this.schedulesService.getAvailableMetricsForAdAccounts(clientUuid);
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

  private async activateSchedulingOptions(ctx: Context) {
    const body = ctx.request.body as ScheduleBulkActionRequest;

    await this.schedulesService.activateSchedulingOptions(body.uuids);

    ctx.body = {
      message: "Report schedule activated successfully",
    };
    ctx.status = 200;
  }
}
