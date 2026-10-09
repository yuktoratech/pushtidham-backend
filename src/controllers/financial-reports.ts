import type { RequestHandler } from "express";
import type { FinancialReportQuery } from "../validators/donation.js";
import { FinancialReportService } from "../services/financial-reports.js";

export function financialReportController(service=new FinancialReportService()):RequestHandler {
  return async(req,res)=>res.json({success:true,data:await service.summary(req.validated.query as FinancialReportQuery)});
}
