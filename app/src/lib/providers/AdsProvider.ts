import type { SectionConfig } from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces";

export interface AdsProvider {
  readonly providerName: string;

  getProviderData(
    sections: SectionConfig[],
    clientUuid: string,
    datePreset: string,
  ): Promise<any[]>;

  authenticate(organizationUuid: string): Promise<void>;

  getCustomMetrics(
    accountIds: string[],
  ): Promise<Record<string, { id: string; name: string }[]>>;
}
