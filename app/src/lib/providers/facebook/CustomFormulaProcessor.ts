import { evaluate, parse, type SymbolNode } from "mathjs";

import {
  AdAccountCustomFormula,
  type CustomFormula,
  Database,
  type ExtendedCustomFormula,
} from "marklie-ts-core";

export class CustomFormulaProcessor {
  /**
   * Fetch and merge custom formula configurations with stored formulas
   */
  static async getExtendedCustomFormulas(
    customFormulaConfigs: CustomFormula[],
  ): Promise<ExtendedCustomFormula[]> {
    const database = await Database.getInstance();

    if (!customFormulaConfigs.length) return [];

    const customFormulaUuids = [
      ...new Set(customFormulaConfigs.map((cf) => cf.uuid)),
    ];

    const storedCustomFormulas = await database.em.find(
      AdAccountCustomFormula,
      {
        uuid: { $in: customFormulaUuids },
      },
    );

    const storedCustomFormulaMap = new Map(
      storedCustomFormulas.map((formula) => [formula.uuid, formula]),
    );

    return customFormulaConfigs
      .map((cf) => {
        const stored = storedCustomFormulaMap.get(cf.uuid);
        if (!stored) return null;
        return {
          ...cf,
          formula: stored.formula,
          format: stored.format,
          description: stored.description ?? "",
        };
      })
      .filter((cf): cf is ExtendedCustomFormula => cf !== null);
  }

  /**
   * Extract variable names from formulas
   */
  static getFormulaVariables(formula: string): string[] {
    try {
      const node = parse(formula);
      return [
        ...new Set(
          node
            .filter((n) => (n as SymbolNode).isSymbolNode)
            .map((n) => (n as SymbolNode).name),
        ),
      ];
    } catch (error) {
      console.error(`Error parsing formula "${formula}":`, error);
      return [];
    }
  }

  /**
   * Evaluate a formula with given metric values
   */
  static evaluateFormula(
    formula: string,
    metricValues: Record<string, number>,
  ): number {
    try {
      const scope: Record<string, number> = { ...metricValues };
      const result = evaluate(formula, scope);

      if (typeof result !== "number" || !isFinite(result) || isNaN(result)) {
        return 0;
      }
      return result;
    } catch {
      return 0;
    }
  }

  /**
   * Get all required metrics (default and custom) for evaluating formulas
   */
  static getRequiredMetrics(extendedCustomFormulas: ExtendedCustomFormula[]): {
    defaultMetrics: string[];
    customMetricIds: string[];
  } {
    const defaultMetrics = new Set<string>();
    const customMetricIds = new Set<string>();

    for (const cf of extendedCustomFormulas) {
      const variables = this.getFormulaVariables(cf.formula);

      for (const variable of variables) {
        if (variable.startsWith("custom_metric_")) {
          const id = variable.replace("custom_metric_", "");
          customMetricIds.add(id);
        } else {
          defaultMetrics.add(variable);
        }
      }
    }

    return {
      defaultMetrics: Array.from(defaultMetrics),
      customMetricIds: Array.from(customMetricIds),
    };
  }

  /**
   * Process custom formulas and return calculated values
   */
  static processCustomFormulas(
    extendedCustomFormulas: ExtendedCustomFormula[],
    metricValues: Record<string, number>,
    customMetricValuesById: Record<string, number>, // <- byId now
  ): Record<string, number> {
    const scope: Record<string, number> = { ...metricValues };

    // expose custom metrics as custom_metric_<id>
    for (const [id, value] of Object.entries(customMetricValuesById)) {
      scope[`custom_metric_${id}`] = value;
    }

    const result: Record<string, number> = {};
    for (const cf of extendedCustomFormulas) {
      result[cf.name] = this.evaluateFormula(cf.formula, scope);
    }
    return result;
  }
}
