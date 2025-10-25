import Router from "koa-router";
import type { Context } from "koa";
import { ReportsService } from "../services/ReportsService.js";
import { MarklieError, User } from "marklie-ts-core";
import {
  type ProviderConfig,
  type SendAfterReviewRequest,
  type UpdateReportMetadataRequest,
  type GenerateReportRequest,
} from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import { ReportsUtil } from "../utils/ReportsUtil.js";

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
    this.post("/generate", this.generateReport.bind(this));
    this.post("/send-after-review", this.sendAfterReview.bind(this));
    this.put("/report-data/:uuid", this.updateReportData.bind(this));
    this.put("/report-metadata/:uuid", this.updateReportMetadata.bind(this));
    this.get("/:uuid/pdf", this.downloadReportPdf.bind(this));
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

  private async generateReport(ctx: Context) {
    const { scheduleUuid } = ctx.request.body as GenerateReportRequest;

    const reportUuid = await this.reportsService.generateReport(scheduleUuid);

    if (!reportUuid) {
      ctx.body = {
        message: "Failed to generate report",
        scheduleUuid: scheduleUuid
      };
      ctx.status = 500;
    }

    ctx.body = {
      message: "Report generated successfully",
      scheduleUuid: scheduleUuid,
      reportUuid: reportUuid
    };
    ctx.status = 200;
  }

  private async updateReportData(ctx: Context) {
    const providers: ProviderConfig[] = ctx.request.body as ProviderConfig[];
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
      await this.reportsService.updateReportMetadata(uuid, {
        messages: metadata.messages,
      });
    }

    if (metadata.colors) {
      await this.reportsService.updateReportMetadata(uuid, {
        colors: metadata.colors,
      });
    }

    if (metadata.reportName) {
      await this.reportsService.updateReportMetadata(uuid, {
        reportName: metadata.reportName,
      });
    }

    ctx.body = {
      message: "Report metrics selections updated successfully",
    };
    ctx.status = 200;
  }

  private async downloadReportPdf(ctx: Context) {
    const uuid = ctx.params.uuid as string;

    const pdfBuffer = await ReportsUtil.generateReportPdf(uuid);
    const report = await this.reportsService.getReport(uuid);

    if (!report) {
      throw MarklieError.notFound("Report", uuid, "reports-service");
    }

    const baseName = (
      report.messaging?.pdfFilename ||
      report.customization?.title ||
      "report"
    ).trim();
    const safeBaseName = baseName.replace(/[^\w.\- ()]/g, "_");
    const filename = safeBaseName.toLowerCase().endsWith(".pdf")
      ? safeBaseName
      : `${safeBaseName}.pdf`;

    ctx.set("Content-Type", "application/pdf");
    ctx.set("Content-Disposition", `attachment; filename="${filename}"`);
    ctx.set("Content-Length", String(pdfBuffer.length));
    ctx.body = pdfBuffer;
    ctx.status = 200;
  }
}
