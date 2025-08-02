import type { ReportScheduleRequest } from "marklie-ts-core/dist/lib/interfaces/SchedulesInterfaces";

export class CronUtil {
  private static mapDayOfWeekToCron(day: string): string {
    switch (day) {
      case "Monday":
        return "MON";
      case "Tuesday":
        return "TUE";
      case "Wednesday":
        return "WED";
      case "Thursday":
        return "THU";
      case "Friday":
        return "FRI";
      case "Saturday":
        return "SAT";
      case "Sunday":
        return "SUN";
      default:
        return "";
    }
  }

  public static convertScheduleRequestToCron(
    req: ReportScheduleRequest,
  ): string {
    switch (req.frequency) {
      case "weekly": {
        const [hour, minute] = req.time.split(":");
        const cronDay = this.mapDayOfWeekToCron(req.dayOfWeek);
        return `${minute} ${hour} * * ${cronDay}`;
      }
      case "biweekly": {
        const [hour, minute] = req.time.split(":");
        const cronDay = this.mapDayOfWeekToCron(req.dayOfWeek);
        return `${minute} ${hour} * * ${cronDay}`;
      }
      case "monthly": {
        const [hour, minute] = req.time.split(":");
        return `${minute} ${hour} ${req.dayOfMonth} * *`;
      }
      case "custom": {
        const [hour, minute] = req.time.split(":");
        return `${minute} ${hour} * * *`;
      }
      case "cron": {
        return req.cronExpression;
      }
      default: {
        return "0 9 * * MON";
      }
    }
  }
}
