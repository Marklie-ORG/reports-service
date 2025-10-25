import { baseEnvSchema, ConfigService } from "marklie-ts-core";
import { z } from "zod";

const reportsEnvSchema = baseEnvSchema.extend({
  FACEBOOK_API_VERSION: z.string().default("v22.0"),
  REPORT_GENERATION_TIMEOUT: z.number().default(120000).pipe(z.coerce.number()),
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
  GCS_REPORTS_BUCKET: z.string(),
  MAX_CONCURRENT_REPORTS: z.string().default("5").pipe(z.coerce.number()),
});

export type ReportsEnvironment = z.infer<typeof reportsEnvSchema>;

export class ReportsConfigService extends ConfigService<ReportsEnvironment> {
  private static instance: ReportsConfigService;

  private constructor() {
    super(reportsEnvSchema, "reports-service");
  }

  public static getInstance(): ReportsConfigService {
    if (!ReportsConfigService.instance) {
      ReportsConfigService.instance = new ReportsConfigService();
    }
    return ReportsConfigService.instance;
  }

  public getFacebookApiUrl(): string {
    return `https://graph.facebook.com/${this.get("FACEBOOK_API_VERSION")}/`;
  }

  public getReportGenerationConfig() {
    return {
      timeout: this.get("REPORT_GENERATION_TIMEOUT"),
      maxConcurrent: this.get("MAX_CONCURRENT_REPORTS"),
      bucketName: this.get("GCS_REPORTS_BUCKET"),
      puppeteerPath: this.get("PUPPETEER_EXECUTABLE_PATH"),
    };
  }

  public getPuppeteerConfig() {
    const executablePath = this.get("PUPPETEER_EXECUTABLE_PATH");
    return {
      headless: "shell",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1600, height: 1000 },
      timeout: this.get("REPORT_GENERATION_TIMEOUT"),
      ...(executablePath && { executablePath }),
    };
  }
}
