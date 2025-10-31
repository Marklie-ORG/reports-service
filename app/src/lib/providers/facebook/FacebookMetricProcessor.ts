import type {
  CustomFormula,
  CustomMetricConfig,
  MetricConfig,
} from "marklie-ts-core";
import type { MetricValue } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces";

type DirectMetric = {
  fields: string[];
  type: string;
};

type ExtractMetric = {
  fields: string[];
  extract: (data: any[]) => number;
  type: string;
};

type CalculatedMetric = {
  calculate: (data: any) => number;
  type: string;
  dependencies?: string[];
};

type MetricDefinition = DirectMetric | ExtractMetric | CalculatedMetric;

export const FACEBOOK_BASE_METRICS: Record<string, MetricDefinition> = {
  // Direct metrics from API
  spend: { fields: ["spend"], type: "currency" },
  impressions: { fields: ["impressions"], type: "number" },
  clicks: { fields: ["clicks"], type: "number" },
  reach: { fields: ["reach"], type: "number" },
  frequency: { fields: ["frequency"], type: "decimal" },

  // Calculated metrics
  cpc: {
    calculate: (data: any) => (data.clicks > 0 ? data.spend / data.clicks : 0),
    type: "currency",
  },
  cpm: {
    calculate: (data: any) =>
      data.impressions > 0 ? (data.spend / data.impressions) * 1000 : 0,
    type: "currency",
  },
  ctr: {
    calculate: (data: any) =>
      data.impressions > 0 ? (data.clicks / data.impressions) * 100 : 0,
    type: "percentage",
  },
  cpp: {
    calculate: (data: any) =>
      data.reach > 0 ? (data.spend / data.reach) * 1000 : 0,
    type: "currency",
  },

  // Action-based metrics
  purchases: {
    fields: ["actions"],
    extract: (actions: any[]) => getActionValue(actions, "omni_purchase"),
    type: "number",
  },
  add_to_cart: {
    fields: ["actions"],
    extract: (actions: any[]) => getActionValue(actions, "omni_add_to_cart"),
    type: "number",
  },
  leads: {
    fields: ["actions"],
    extract: (actions: any[]) => getActionValue(actions, "lead"),
    type: "number",
  },
  conversion_value: {
    fields: ["action_values"],
    extract: (values: any[]) => getActionValue(values, "omni_purchase"),
    type: "currency",
  },

  // Compound calculated metrics
  purchase_roas: {
    calculate: (data: any) =>
      data.spend > 0 ? data.conversion_value / data.spend : 0,
    type: "decimal",
    dependencies: ["conversion_value", "spend"],
  },
  cost_per_purchase: {
    calculate: (data: any) =>
      data.purchases > 0 ? data.spend / data.purchases : 0,
    type: "currency",
    dependencies: ["purchases", "spend"],
  },
  cost_per_add_to_cart: {
    calculate: (data: any) =>
      data.add_to_cart > 0 ? data.spend / data.add_to_cart : 0,
    type: "currency",
    dependencies: ["add_to_cart", "spend"],
  },
  cost_per_lead: {
    calculate: (data: any) => (data.leads > 0 ? data.spend / data.leads : 0),
    type: "currency",
    dependencies: ["leads", "spend"],
  },
  conversion_rate: {
    calculate: (data: any) =>
      data.landing_page_views > 0
        ? (data.purchases / data.landing_page_views) * 100
        : 0,
    type: "percentage",
    dependencies: ["purchases", "landing_page_views"],
  },
};

function getActionValue(actions: any[], type: string): number {
  return Number(actions?.find((a: any) => a.action_type === type)?.value || 0);
}

export class FacebookMetricProcessor {
  /**
   * Extract base values from Facebook API response
   */
  static extractBaseValues(apiData: any): Record<string, any> {
    const values: Record<string, any> = {};

    // Direct fields
    for (const [metric, config] of Object.entries(FACEBOOK_BASE_METRICS)) {
      if (
        "fields" in config &&
        !("extract" in config) &&
        !("calculate" in config)
      ) {
        // Type guard ensures this is a DirectMetric
        const directConfig = config as DirectMetric;
        if (directConfig.fields.length === 1) {
          values[metric] = Number(apiData[directConfig.fields[0]] || 0);
        }
      }
    }

    // Action-based extractions
    if (apiData.actions) {
      for (const [metric, config] of Object.entries(FACEBOOK_BASE_METRICS)) {
        if ("extract" in config && "fields" in config) {
          // Type guard ensures this is an ExtractMetric
          const extractConfig = config as ExtractMetric;
          if (extractConfig.fields.includes("actions")) {
            values[metric] = extractConfig.extract(apiData.actions);
          }
        }
      }
    }

    if (apiData.action_values) {
      for (const [metric, config] of Object.entries(FACEBOOK_BASE_METRICS)) {
        if ("extract" in config && "fields" in config) {
          // Type guard ensures this is an ExtractMetric
          const extractConfig = config as ExtractMetric;
          if (extractConfig.fields.includes("action_values")) {
            values[metric] = extractConfig.extract(apiData.action_values);
          }
        }
      }
    }

    // Special case for landing page views
    if (apiData.actions) {
      values.landing_page_views = getActionValue(
        apiData.actions,
        "landing_page_view",
      );
    }

    return values;
  }

  /**
   * Calculate derived metrics
   */
  static calculateDerivedMetrics(
    baseValues: Record<string, any>,
  ): Record<string, number> {
    const calculated: Record<string, number> = { ...baseValues };

    // Calculate metrics with dependencies
    let hasChanges = true;
    let iterations = 0;

    while (hasChanges && iterations < 10) {
      hasChanges = false;
      iterations++;

      for (const [metric, config] of Object.entries(FACEBOOK_BASE_METRICS)) {
        if ("calculate" in config) {
          const oldValue = calculated[metric];

          // Check if all dependencies are available
          const deps = (config as any).dependencies || [];
          const hasAllDeps = deps.every(
            (dep: string) => calculated[dep] !== undefined,
          );

          if (hasAllDeps || deps.length === 0) {
            calculated[metric] = config.calculate(calculated);
            if (oldValue !== calculated[metric]) {
              hasChanges = true;
            }
          }
        }
      }
    }

    return calculated;
  }

  /**
   * Process custom metrics from actions
   */
  static extractCustomMetrics(
    apiData: any,
    customMetrics: CustomMetricConfig[] = [],
  ): { byId: Record<string, number>; byName: Record<string, number> } {
    const byId: Record<string, number> = {};
    const byName: Record<string, number> = {};
    const nameById = new Map(customMetrics.map((m) => [m.id, m.name]));

    const bump = (obj: Record<string, number>, k: string, v: any) =>
      (obj[k] = (obj[k] ?? 0) + Number(v ?? 0));

    const scan = (list?: any[]) => {
      if (!Array.isArray(list)) return;
      for (const a of list) {
        const m = String(a?.action_type ?? "").match(
          /^offsite_conversion\.custom\.(\d+)$/,
        );
        if (!m) continue;
        const id = m[1];
        bump(byId, id, a?.value);
        const name = nameById.get(id);
        if (name) bump(byName, name, a?.value);
      }
    };

    scan(apiData?.actions);
    scan(apiData?.action_values);

    return { byId, byName };
  }

  static toMetricValues(
    baseValues: Record<string, number>,
    selected: (MetricConfig | CustomMetricConfig)[],
    customByName: Record<string, number> = {},
    formulaValues: Record<string, number> = {},
    formulaConfigs: CustomFormula[] = [],
  ): MetricValue[] {
    const byName = new Map<string, MetricValue>();

    for (const m of selected) {
      const name = m.name;
      const v =
        name in baseValues
          ? baseValues[name]
          : name in customByName
            ? customByName[name]
            : 0;
      byName.set(name, {
        name,
        value: v,
        order: m.order,
        enabled: m.enabled !== false,
      });
    }

    // 2) formulas
    for (const f of formulaConfigs) {
      const v = formulaValues[f.name] ?? 0;
      byName.set(f.name, {
        name: f.name,
        value: v,
        order: f.order,
        enabled: true,
      });
    }

    return [...byName.values()].sort((a, b) => a.order - b.order);
  }
}
