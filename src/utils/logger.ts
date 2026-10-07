export function log(
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }),
  );
}
