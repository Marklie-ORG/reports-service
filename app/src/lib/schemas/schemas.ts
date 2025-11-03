import { z } from "zod";
import {
  DatePresetSchema,
  DayOfWeekSchema,
  FrequencySchema,
  TimeSchema,
  UuidSchema,
} from "marklie-ts-core";

export const ReportColorsSchema = z.object({
  headerBackgroundColor: z.string().optional(),
  reportBackgroundColor: z.string().optional(),
  headerTextColor: z.string().optional(),
  reportTextColor: z.string().optional(),
  accentColor: z.string().optional(),
});

export const ReportMessagesSchema = z.object({
  emailSubject: z.string().optional(),
  emailBody: z.string().optional(),
  slackMessage: z.string().optional(),
  whatsappMessage: z.string().optional(),
});

export const ReportImagesSchema = z.object({
  clientLogoGsUri: z.string().optional(),
  organizationLogoGsUri: z.string().optional(),
});

export const GenerateReportRequestSchema = z.object({
  scheduleUuid: UuidSchema,
});

export const SendAfterReviewRequestSchema = z.object({
  reportUuid: UuidSchema,
  sendAt: z.string().datetime().optional(),
});

export const UpdateReportMetadataRequestSchema = z.object({
  images: ReportImagesSchema.optional(),
  messages: ReportMessagesSchema.optional(),
  colors: ReportColorsSchema.optional(),
  reportName: z.string().optional(),
});

export const ProviderMetricSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  category: z.string(),
  type: z.string(),
  selected: z.boolean().optional(),
  order: z.number().optional(),
});

export const ProviderAdAccountSchema = z.object({
  adAccountId: z.string(),
  adAccountName: z.string(),
  metrics: z.array(ProviderMetricSchema),
});

export const ProviderSectionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  adAccounts: z.array(ProviderAdAccountSchema),
});

export const ProviderConfigSchema = z.object({
  provider: z.string(),
  sections: z.array(ProviderSectionSchema),
});

export const ReportScheduleRequestSchema = z.object({
  clientUuid: UuidSchema,
  organizationUuid: UuidSchema,
  frequency: FrequencySchema,
  dayOfWeek: DayOfWeekSchema.optional(),
  timeOfDay: TimeSchema.optional(),
  cronExpression: z.string().optional(),
  datePreset: DatePresetSchema.optional(),
  providers: z.array(ProviderConfigSchema),
  templateUuid: UuidSchema.optional(),
  uuid: UuidSchema.optional(),
  colors: ReportColorsSchema.optional(),
  messages: ReportMessagesSchema.optional(),
  images: ReportImagesSchema.optional(),
  reportName: z.string().optional(),
});

export const ScheduleBulkActionRequestSchema = z.object({
  uuids: z.array(UuidSchema),
});

export const FormulaVariableSchema = z.object({
  name: z.string(),
  metricName: z.string(),
});

export const CreateAdAccountCustomFormulaRequestSchema = z.object({
  adAccountId: z.string(),
  name: z.string(),
  displayName: z.string(),
  formula: z.string(),
  variables: z.array(FormulaVariableSchema),
  provider: z.string(),
});

export const UpdateAdAccountCustomFormulaRequestSchema = z.object({
  name: z.string().optional(),
  displayName: z.string().optional(),
  formula: z.string().optional(),
  variables: z.array(FormulaVariableSchema).optional(),
});

export const CreateOptionFromTemplateRequestSchema = z.object({
  templateUuid: UuidSchema,
  clientUuid: UuidSchema,
});

export const TemplateOriginSchema = z.enum(['system', 'user']);
export const TemplateVisibilitySchema = z.enum(['private', 'public']);

export const CreateTemplateFromOptionRequestSchema = z.object({
  optionUuid: UuidSchema,
  params: z.object({
    name: z.string(),
    description: z.string(),
    origin: TemplateOriginSchema,
    visibility: TemplateVisibilitySchema,
    organizationUuid: z.string().nullable(),
  }).partial(),
});

export type GenerateReportRequest = z.infer<typeof GenerateReportRequestSchema>;
export type SendAfterReviewRequest = z.infer<
  typeof SendAfterReviewRequestSchema
>;
export type UpdateReportMetadataRequest = z.infer<
  typeof UpdateReportMetadataRequestSchema
>;
export type ReportScheduleRequest = z.infer<typeof ReportScheduleRequestSchema>;
export type ScheduleBulkActionRequest = z.infer<
  typeof ScheduleBulkActionRequestSchema
>;
export type CreateAdAccountCustomFormulaRequest = z.infer<
  typeof CreateAdAccountCustomFormulaRequestSchema
>;
export type UpdateAdAccountCustomFormulaRequest = z.infer<
  typeof UpdateAdAccountCustomFormulaRequestSchema
>;
export type CreateOptionFromTemplateRequest = z.infer<
  typeof CreateOptionFromTemplateRequestSchema
>;
export type CreateTemplateFromOptionRequest = z.infer<
  typeof CreateTemplateFromOptionRequestSchema
>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ReportColors = z.infer<typeof ReportColorsSchema>;
export type ReportMessages = z.infer<typeof ReportMessagesSchema>;
export type ReportImages = z.infer<typeof ReportImagesSchema>;
