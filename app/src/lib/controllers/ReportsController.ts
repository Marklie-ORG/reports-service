import Router from "koa-router";
import type { Context } from "koa";
import { ReportsService } from "../services/ReportsService.js";
import { MarklieError, User } from "marklie-ts-core";
import {
  type SendAfterReviewRequest,
  type UpdateReportMetadataRequest
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
    this.put("/report-data/:uuid", this.updateReportData.bind(this));
    this.put("/report-metadata/:uuid", this.updateReportMetadata.bind(this));
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
      await this.reportsService.sendReportAfterReview(
        body.reportUuid,
        body.sendAt,
      );

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

  private async updateReportData(ctx: Context) {
    const providers: ScheduledProviderConfig[] = ctx.request
      .body as ScheduledProviderConfig[];
    const uuid = ctx.params.uuid as string;

    await this.reportsService.updateReportData(uuid, providers);

    ctx.body = {
      message: "Report metrics selections updated successfully",
    };
    ctx.status = 200;
  }

  private async updateReportMetadata(ctx: Context) {
    const metadata: UpdateReportMetadataRequest = ctx.request
      .body as UpdateReportMetadataRequest;
    const uuid = ctx.params.uuid as string;

    if (metadata.images) {
      await this.reportsService.updateReportImages(uuid, {
        clientLogo: metadata.images.clientLogoGsUri,
        organizationLogo: metadata.images.organizationLogoGsUri,
      });
    }

    if (metadata.messages) {
      await this.reportsService.updateReportMetadata(uuid, { messages: metadata.messages });
    }

    if (metadata.colors) {
      await this.reportsService.updateReportMetadata(uuid, { colors: metadata.colors });
    }

    if (metadata.reportName) {
      await this.reportsService.updateReportMetadata(uuid, { reportName: metadata.reportName });
    }

    ctx.body = {
      message: "Report metrics selections updated successfully",
    };
    ctx.status = 200;
  }

}
