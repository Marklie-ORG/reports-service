import {
  BullMQWrapper,
  ErrorCode,
  MarklieError,
  PubSubWrapper,
  RedisClient,
} from "marklie-ts-core";
import type { ReportJobData } from "marklie-ts-core/dist/lib/interfaces/ReportsInterfaces.js";
import { ReportsUtil } from "../utils/ReportsUtil.js";
import type { Job } from "bullmq";

export class ReportQueueService {
  private static instance: ReportQueueService;
  private queue: BullMQWrapper;

  private constructor() {
    this.queue = new BullMQWrapper(
      "report-queue",
      RedisClient.getInstance().duplicate(),
      {
        "generate-report": this.generateReportJob.bind(this),
        "send-reviewed-report": this.sendReviewedReportJob.bind(this),
      },
    );
  }

  public static getInstance(): ReportQueueService {
    if (!ReportQueueService.instance) {
      ReportQueueService.instance = new ReportQueueService();
    }
    return ReportQueueService.instance;
  }

  private async generateReportJob(data: ReportJobData): Promise<void> {
    try {
      await ReportsUtil.processScheduledReportJob(data);
    } catch (err) {
      throw new MarklieError(
        `Could not process job ${JSON.stringify(err)}`,
        ErrorCode.INTERNAL_ERROR,
      );
    }
  }

  private async sendReviewedReportJob(data: ReportJobData): Promise<void> {
    try {
      await PubSubWrapper.publishMessage("notification-send-report", data);
    } catch (err) {
      throw err;
    }
  }

  public async getAllJobs(): Promise<Job[]> {
    return await this.queue.listScheduledJobs();
  }

  public async scheduleReport(
    data: ReportJobData,
    cron: string,
  ): Promise<Job | undefined> {
    return await this.queue.addScheduledJob("generate-report", data, cron);
  }

  public async enqueueReport(data: ReportJobData): Promise<Job> {
    return await this.queue.addJob("generate-report", data, {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 20_000,
      },
    });
  }

  public async scheduleOneTimeReport(
    jobData: any,
    delayMs: number,
  ): Promise<Job> {
    return await this.queue.addJob("send-reviewed-report", jobData, {
      delay: delayMs,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 10000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  public async deleteAllScheduledJobs(): Promise<void> {
    const repeatableJobs = await this.queue.listScheduledJobs();
    for (const job of repeatableJobs) {
      await this.queue.removeScheduledJob(job.key);
    }
    await this.queue.drainAndClean();
  }

  public async getJob(jobId: string): Promise<Job | null> {
    return await this.queue.getJob(jobId);
  }

  public async removeScheduledJob(jobId: string): Promise<void> {
    await this.queue.removeScheduledJob(jobId);
  }

  public async close(): Promise<void> {
    await this.queue.close();
  }
}
