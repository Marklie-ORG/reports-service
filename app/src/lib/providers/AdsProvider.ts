import type { CustomMetric } from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces";
import type { OrderedMetric } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces";

export interface SectionConfig {
  name: "kpis" | "graphs" | "ads" | "campaigns";
  order: number;
  adAccounts: SectionAdAccount[];
}
interface SectionAdAccount {
  adAccountId: string;
  order: number;
  metrics: OrderedMetric<string>[];
  customMetrics?: CustomMetric[];
}
export interface AdsProvider {
  readonly providerName: string;

  getProviderData(
    sections: SectionConfig[],
    clientUuid: string,
    organizationUuid: string,
    datePreset: string,
  ): Promise<any[]>;

  authenticate(organizationUuid: string): Promise<void>;

  getCustomMetrics(
    accountIds: string[],
  ): Promise<Record<string, { id: string; name: string }[]>>;
}
