import {
  AdAccountCustomFormula,
  ClientAdAccount,
  Database,
} from "marklie-ts-core";
import type {
  CreateAdAccountCustomFormulaRequest,
  UpdateAdAccountCustomFormulaRequest,
} from "marklie-ts-core/dist/lib/interfaces/CustomFormulasInterfaces.js";

const database = await Database.getInstance();

export class CustomFormulasService {
  async createCustomFormula(
    formula: CreateAdAccountCustomFormulaRequest,
  ): Promise<AdAccountCustomFormula> {
    const adAccount = await database.em.findOne(ClientAdAccount, {
      adAccountId: formula.adAccountId,
    });

    if (!adAccount) {
      throw new Error(`No ad account was found with ${formula.adAccountId}`);
    }

    const customFormula = database.em.create(AdAccountCustomFormula, {
      name: formula.name,
      formula: formula.formula,
      format: formula.format,
      description: formula.description ?? null,
      adAccount: adAccount,
    });
    await database.em.persistAndFlush(customFormula);
    return customFormula;
  }

  async getCustomFormula(uuid: string): Promise<AdAccountCustomFormula> {
    const customFormula = await database.em.findOne(AdAccountCustomFormula, {
      uuid,
    });
    if (!customFormula) throw new Error(`Custom formula ${uuid} not found`);
    return customFormula;
  }

  async getAdAccountCustomFormulas(
    adAccountId: string,
  ): Promise<AdAccountCustomFormula[]> {
    return database.em.find(AdAccountCustomFormula, { adAccount: adAccountId });
  }

  async updateCustomFormula(
    uuid: string,
    formula: UpdateAdAccountCustomFormulaRequest,
  ): Promise<AdAccountCustomFormula> {
    const customFormula = await database.em.findOne(AdAccountCustomFormula, {
      uuid,
    });
    if (!customFormula) throw new Error(`Custom formula ${uuid} not found`);
    customFormula.formula = formula.formula;
    if (formula.name) customFormula.name = formula.name;
    if (formula.format) customFormula.format = formula.format;
    if (formula.description !== undefined)
      customFormula.description = formula.description;
    await database.em.persistAndFlush(customFormula);
    return customFormula;
  }

  async deleteCustomFormula(uuid: string): Promise<void> {
    const customFormula = await database.em.findOne(AdAccountCustomFormula, {
      uuid,
    });
    if (!customFormula) throw new Error(`Custom formula ${uuid} not found`);
    await database.em.removeAndFlush(customFormula);
  }
}
