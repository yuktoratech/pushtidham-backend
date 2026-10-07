import type { Model } from "mongoose";
import type { ListQuery } from "../validators/common.js";
export function escapeRegex(value: string) {
  const specials = ".*+?^$" + "{}()|[]\\";
  return [...value]
    .map((char) => (specials.includes(char) ? "\\" + char : char))
    .join("");
}
export async function paginate<T>(
  model: Model<T>,
  filter: Record<string, unknown>,
  query: ListQuery,
  sort: Record<string, 1 | -1> = { createdAt: -1, _id: -1 },
) {
  const [data, total] = await Promise.all([
    model
      .find(filter)
      .sort(sort)
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    model.countDocuments(filter),
  ]);
  return {
    data,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      pages: Math.ceil(total / query.limit),
    },
  };
}
