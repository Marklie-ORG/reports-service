import Router from "koa-router";
import type { Context } from "koa";
import { CustomFormulasService } from "lib/services/CustomFormulasService.js";
import type { CreateAdAccountCustomFormulaRequest, UpdateAdAccountCustomFormulaRequest } from "marklie-ts-core/dist/lib/interfaces/CustomFormulasInterfaces";

export class CustomFormulasController extends Router {
  private readonly customFormulasService: CustomFormulasService;
  constructor() {
    super({ prefix: "/api/custom-formulas" });
    this.customFormulasService = new CustomFormulasService();
    this.setUpRoutes();
  }

  private setUpRoutes() {
    this.post("/", this.createCustomFormula.bind(this));
    this.get("/:uuid", this.getCustomFormula.bind(this));
    this.get("/ad-account/:uuid", this.getAdAccountCustomFormulas.bind(this));
    this.put("/:uuid", this.updateCustomFormula.bind(this));
    this.delete("/:uuid", this.deleteCustomFormula.bind(this));
  }

  private async createCustomFormula(ctx: Context) {
    const formula = ctx.request.body as CreateAdAccountCustomFormulaRequest;
    const customFormula = await this.customFormulasService.createCustomFormula(formula);
    ctx.body = customFormula;
    ctx.status = 200;
  }

  private async getAdAccountCustomFormulas(ctx: Context) {
    const adAccountId = ctx.params.uuid as string;
    const customFormulas = await this.customFormulasService.getAdAccountCustomFormulas(adAccountId);
    ctx.body = customFormulas;
    ctx.status = 200;
  }

  private async updateCustomFormula(ctx: Context) {
    const uuid = ctx.params.uuid as string;
    const formula = ctx.request.body as UpdateAdAccountCustomFormulaRequest;
    const customFormula = await this.customFormulasService.updateCustomFormula(uuid, formula);
    ctx.body = customFormula;
    ctx.status = 200;
  }

  private async deleteCustomFormula(ctx: Context) {
    const uuid = ctx.params.uuid as string;
    await this.customFormulasService.deleteCustomFormula(uuid);
    ctx.status = 200;
  }

  private async getCustomFormula(ctx: Context) {
    const uuid = ctx.params.uuid as string;
    const customFormula = await this.customFormulasService.getCustomFormula(uuid);
    ctx.body = customFormula;
    ctx.status = 200;
  }

}
