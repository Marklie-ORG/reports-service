import type { AdsProvider } from "./AdsProvider.js";
import { FacebookProvider } from "./FacebookProvider.js";

export class ProviderFactory {
  private static providers = new Map<
    string,
    new (...args: any[]) => AdsProvider
  >();

  static {
    this.register("facebook", FacebookProvider);
  }

  static register(
    providerName: string,
    providerClass: new (...args: any[]) => AdsProvider,
  ) {
    this.providers.set(providerName, providerClass);
  }

  static create(
    providerName: string,
    organizationUuid: string,
    accountId?: string,
  ): AdsProvider {
    const ProviderClass = this.providers.get(providerName);
    if (!ProviderClass) {
      throw new Error(`Provider ${providerName} not found`);
    }
    return new ProviderClass(organizationUuid, accountId);
  }

  static getAvailableProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}
