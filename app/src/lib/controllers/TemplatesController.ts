import Router from "@koa/router";
import type { Context } from "koa";
import { SchedulingTemplateService } from "../services/TemplatesService.js";
import type {
  TemplateOrigin,
  TemplateVisibility,
} from "marklie-ts-core/dist/lib/entities/SchedulingTemplate.js";

export class TemplatesController extends Router {
  private readonly templateService: SchedulingTemplateService;
  constructor() {
    super({ prefix: "/api/schedule-templates" });
    this.templateService = new SchedulingTemplateService();
    this.setUpRoutes();
  }

  private setUpRoutes() {
    this.post(
      "/option-from-template",
      this.createOptionFromTemplate.bind(this),
    );
    this.post(
      "/template-from-option",
      this.createTemplateFromOption.bind(this),
    );
    this.get("/all", this.getAllTemplates.bind(this));
    this.get("/:templateUuid", this.getTemplateByUuid.bind(this));
  }

  private async createOptionFromTemplate(ctx: Context) {
    const body = ctx.request.body as {
      templateUuid: string;
      clientUuid: string;
    };

    ctx.body = await this.templateService.createOptionFromTemplate(
      body.templateUuid,
      body.clientUuid,
    );
    ctx.status = 200;
  }

  private async createTemplateFromOption(ctx: Context) {
    const body = ctx.request.body as {
      optionUuid: string;
      params: Partial<{
        name: string;
        description: string;
        origin: TemplateOrigin;
        visibility: TemplateVisibility;
        organizationUuid: string | null;
      }>;
    };

    ctx.body = await this.templateService.createTemplateFromOption(
      body.optionUuid,
      body.params,
    );
    ctx.status = 200;
  }

  private async getAllTemplates(ctx: Context) {
    ctx.body = await this.templateService.getAllTemplates();
    ctx.status = 200;
  }

  private async getTemplateByUuid(ctx: Context) {
    const { templateUuid } = ctx.params;

    ctx.body = await this.templateService.getTemplateByUuid(templateUuid);
    ctx.status = 200;
  }
}
