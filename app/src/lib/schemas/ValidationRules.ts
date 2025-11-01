import type { ValidationRule } from "marklie-ts-core";
import {
  CreateAdAccountCustomFormulaRequestSchema,
  CreateOptionFromTemplateRequestSchema,
  CreateTemplateFromOptionRequestSchema,
  GenerateReportRequestSchema,
  ProviderConfigSchema,
  ReportScheduleRequestSchema,
  ScheduleBulkActionRequestSchema,
  SendAfterReviewRequestSchema,
  UpdateAdAccountCustomFormulaRequestSchema,
  UpdateReportMetadataRequestSchema,
} from "./schemas.js";
import { z } from "zod";

export const reportsValidationRules: ValidationRule[] = [
  {
    path: "/api/reports/generate",
    method: "POST",
    schema: GenerateReportRequestSchema,
  },
  {
    path: "/api/reports/send-after-review",
    method: "POST",
    schema: SendAfterReviewRequestSchema,
  },
  {
    path: "/api/reports/report-metadata/:uuid",
    method: "PUT",
    schema: UpdateReportMetadataRequestSchema,
  },
  {
    path: "/api/reports/report-data/:uuid",
    method: "PUT",
    schema: z.array(ProviderConfigSchema),
  },

  {
    path: "/api/scheduling-options/schedule",
    method: "POST",
    schema: ReportScheduleRequestSchema,
  },
  {
    path: "/api/scheduling-options/:uuid",
    method: "PUT",
    schema: ReportScheduleRequestSchema,
  },
  {
    path: "/api/scheduling-options/stop",
    method: "PUT",
    schema: ScheduleBulkActionRequestSchema,
  },
  {
    path: "/api/scheduling-options/delete",
    method: "PUT",
    schema: ScheduleBulkActionRequestSchema,
  },
  {
    path: "/api/scheduling-options/activate",
    method: "PUT",
    schema: ScheduleBulkActionRequestSchema,
  },

  {
    path: "/api/custom-formulas",
    method: "POST",
    schema: CreateAdAccountCustomFormulaRequestSchema,
  },
  {
    path: "/api/custom-formulas/:uuid",
    method: "PUT",
    schema: UpdateAdAccountCustomFormulaRequestSchema,
  },
  {
    path: "/api/schedule-templates/option-from-template",
    method: "POST",
    schema: CreateOptionFromTemplateRequestSchema,
  },
  {
    path: "/api/schedule-templates/template-from-option",
    method: "POST",
    schema: CreateTemplateFromOptionRequestSchema,
  },
];
