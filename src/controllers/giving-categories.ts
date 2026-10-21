import type {RequestHandler} from "express";
import type {GivingCategoryInput} from "../validators/catalog.js";
import type {ListQuery} from "../validators/common.js";
import {CatalogService} from "../services/catalog.js";
export function givingCategoryController(service: CatalogService, admin = false) {
  return {
    list: (async (req, res) => res.json({success: true, ...(await service.listGivingCategories(req.validated.query as ListQuery & {status?:string}, admin))})) as RequestHandler,
    get: (async (req, res) => res.json({success: true, data: await service.getGivingCategory((req.validated.params as {id?: string; slug?: string})[admin ? "id" : "slug"]!, admin)})) as RequestHandler,
    create: (async (req, res) => res.status(201).json({success: true, data: await service.createGivingCategory(req.validated.body as GivingCategoryInput)})) as RequestHandler,
    replace: (async (req, res) => res.json({success: true, data: await service.replaceGivingCategory((req.validated.params as {id: string}).id, req.validated.body as GivingCategoryInput)})) as RequestHandler,
    status: (async (req, res) => res.json({success: true, data: await service.statusGivingCategory((req.validated.params as {id: string}).id, (req.validated.body as {status: string}).status)})) as RequestHandler,
    remove: (async (req, res) => {await service.removeGivingCategory((req.validated.params as {id: string}).id); res.status(204).end();}) as RequestHandler,
  };
}
