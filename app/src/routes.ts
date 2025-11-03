import { ReportsController } from "./lib/controllers/ReportsController.js";
import { SchedulesController } from "./lib/controllers/SchedulesController.js";
import { CustomFormulasController } from "./lib/controllers/CustomFormulasController.js";
import { TemplatesController } from "./lib/controllers/TemplatesController.js";
import { MarklieRouter } from "marklie-ts-core";

const reportsController = new ReportsController();
const schedulesController = new SchedulesController();
const customFormulasController = new CustomFormulasController();
const templatesController = new TemplatesController();

const controllers = [
  reportsController,
  schedulesController,
  customFormulasController,
  templatesController,
];

export const routes = MarklieRouter.compose(controllers);
