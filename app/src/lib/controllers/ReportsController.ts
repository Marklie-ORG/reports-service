import Router from "koa-router";
import type { Context } from "koa";
import { ReportsService } from "../services/ReportsService.js";
import { MarklieError, User } from "marklie-ts-core";
import {
  type SendAfterReviewRequest,
  type ReportImages,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import type { ScheduledProviderConfig } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces.js";

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
    this.get("/client/:uuid", this.getClientReports.bind(this));
    this.get("/pending-review/count", this.getPendingReviewCount.bind(this));
    this.post("/send-after-review", this.sendAfterReview.bind(this));
    this.put("/report-images/:uuid", this.updateReportImages.bind(this));
    this.put("/report-title/:uuid", this.updateReportTitle.bind(this));
    this.put(
      "/report-data/:uuid",
      this.updateReportData.bind(this),
    );
    this.put("/report-messages/:uuid", this.updateReportMessages.bind(this));
  }

  private async getReport(ctx: Context) {
    const uuid = ctx.params.uuid as string;

    const report = await this.reportsService.getReport(uuid);

    if (!report) {
      throw MarklieError.notFound("Report", uuid, "reports-service");
    }

    ctx.body = report;
    ctx.status = 200;
  }

  private async getReports(ctx: Context) {
    const user = ctx.state.user as User;

    ctx.body = await this.reportsService.getReports(
      user.activeOrganization?.uuid,
    );
    ctx.status = 200;
  }

  private async getClientReports(ctx: Context) {
    const clientUuid = ctx.params.uuid as string;
    ctx.body = await this.reportsService.getClientReports(clientUuid);
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

  private async getPendingReviewCount(ctx: Context) {
    const user = ctx.state.user as User;
    const count = await this.reportsService.getPendingReviewCount(
      user.activeOrganization?.uuid,
    );
    ctx.body = { count };
    ctx.status = 200;
  }

  private async updateReportImages(ctx: Context) {
    const images: ReportImages = ctx.request.body as ReportImages;
    const uuid = ctx.params.uuid as string;

    await this.reportsService.updateReportImages(uuid, images);

    ctx.body = {
      message: "Report images updated successfully",
    };
    ctx.status = 200;
  }

  private async updateReportTitle(ctx: Context) {
    const { reportName } = ctx.request.body as { reportName: string };
    const uuid = ctx.params.uuid as string;

    if (typeof reportName !== "string") {
      throw MarklieError.badRequest("Invalid reportName provided", undefined, "reports-service");
    }

    await this.reportsService.updateReportTitle(uuid, reportName);

    ctx.body = {
      message: "Report title updated successfully",
    };
    ctx.status = 200;
  }

  private async updateReportData(ctx: Context) {
    const providers: ScheduledProviderConfig[] = ctx.request
      .body as ScheduledProviderConfig[];
    const uuid = ctx.params.uuid as string;

    await this.reportsService.updateReportData(
      uuid,
      providers,
    );

    ctx.body = {
      message: "Report metrics selections updated successfully",
    };
    ctx.status = 200;
  }

  private async updateReportMessages(ctx: Context) {
    const uuid = ctx.params.uuid as string;
    const messages = ctx.request.body as any;

    await this.reportsService.updateReportMessages(uuid, messages);

    ctx.body = {
      message: "Report messages updated successfully",
    };
    ctx.status = 200;
  }
}
