import type { ScheduledAdAccountConfig } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces";

export interface AdsProvider {
  readonly providerName: string;

  getProviderData(
    adAccountsConfig: ScheduledAdAccountConfig[],
    clientUuid: string,
    organizationUuid: string,
    datePreset: string,
  ): Promise<any[]>;

  authenticate(organizationUuid: string): Promise<void>;
  getCustomMetrics(
    accountIds: string[],
  ): Promise<Record<string, { id: string; name: string }[]>>;
}
