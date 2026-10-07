import type { RequestHandler } from "express";
import type { z } from "zod";
import { CatalogService } from "../services/catalog.js";
import type {
  GivingInput,
  EventInput,
  givingQuery,
  eventQuery,
} from "../validators/catalog.js";
export function catalogController(
  service: CatalogService,
  kind: "giving" | "event",
  admin = false,
) {
  const handlers: Record<
    "list" | "get" | "create" | "replace" | "status" | "remove",
    RequestHandler
  > = {
    list: async (req, res) => {
      const query = req.validated.query as
        z.infer<typeof givingQuery> | z.infer<typeof eventQuery>;
      const result =
        kind === "giving"
          ? await service.listGiving(query, admin)
          : await service.listEvents(query, admin);
      res.json({ success: true, ...result });
    },
    get: async (req, res) => {
      const params = req.validated.params as {
        id?: string;
        slug?: string;
      };
      res.json({
        success: true,
        data: await service.get(
          kind,
          (admin ? params.id : params.slug)!,
          admin,
        ),
      });
    },
    create: async (req, res) => {
      const data =
        kind === "giving"
          ? await service.createGiving(req.validated.body as GivingInput)
          : await service.createEvent(req.validated.body as EventInput);
      res.status(201).json({ success: true, data });
    },
    replace: async (req, res) => {
      const { id } = req.validated.params as {
        id: string;
      };
      const data =
        kind === "giving"
          ? await service.replaceGiving(id, req.validated.body as GivingInput)
          : await service.replaceEvent(id, req.validated.body as EventInput);
      res.json({ success: true, data });
    },
    status: async (req, res) =>
      res.json({
        success: true,
        data: await service.status(
          kind,
          (
            req.validated.params as {
              id: string;
            }
          ).id,
          (
            req.validated.body as {
              status: string;
            }
          ).status,
        ),
      }),
    remove: async (req, res) => {
      await service.remove(
        kind,
        (
          req.validated.params as {
            id: string;
          }
        ).id,
      );
      res.status(204).end();
    },
  };
  return handlers;
}
