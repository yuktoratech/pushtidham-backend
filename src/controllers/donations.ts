import type { RequestHandler } from "express";
import type { DonationInput, DonationQuery } from "../validators/donation.js";
import { DonationService } from "../services/donations.js";
export function donationController(service: DonationService, admin = false) {
  const handlers: Record<"create" | "list" | "get" | "status", RequestHandler> =
    {
      create: async (req, res) =>
        res
          .status(201)
          .json({
            success: true,
            data: await service.create(
              req.validated.body as DonationInput,
              req.principal?.id,
              admin,
            ),
          }),
      list: async (req, res) =>
        res.json({
          success: true,
          ...(await service.list(
            req.validated.query as DonationQuery,
            admin ? undefined : req.principal!.id,
          )),
        }),
      get: async (req, res) =>
        res.json({
          success: true,
          data: await service.get(
            (
              req.validated.params as {
                id: string;
              }
            ).id,
            admin ? undefined : req.principal!.id,
          ),
        }),
      status: async (req, res) =>
        res.json({
          success: true,
          data: await service.status(
            (
              req.validated.params as {
                id: string;
              }
            ).id,
            req.validated.body as {
              status: "completed" | "rejected";
              adminNote?: string;
            },
            req.principal!.id,
          ),
        }),
    };
  return handlers;
}
