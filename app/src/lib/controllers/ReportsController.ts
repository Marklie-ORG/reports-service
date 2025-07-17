import Router from "koa-router";
import type { Context } from "koa";
import { ReportsService } from "../services/ReportsService.js";
import { User } from "marklie-ts-core";
import { type SendAfterReviewRequest } from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";

export class ReportsController extends Router {
  private readonly reportsService: ReportsService;
  constructor() {
    super({ prefix: "/api/reports" });
    this.reportsService = new ReportsService();
    this.setUpRoutes();
  }

  private setUpRoutes() {
    this.get("/:uuid", this.getReport.bind(this));
    this.get("/", this.getReports.bind(this));
    this.post("/send-after-review", this.sendAfterReview.bind(this));
  }

  private async getReport(ctx: Context) {
    const uuid = ctx.params.uuid as string;

    ctx.body = await this.reportsService.getReport(uuid);
    ctx.status = 200;
  }

  private async getReports(ctx: Context) {
    const user = ctx.state.user as User;

    ctx.body = await this.reportsService.getReports(
      user.activeOrganization?.uuid,
    );
    ctx.status = 200;
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
}
