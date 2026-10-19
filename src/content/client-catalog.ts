export const festivalGroups = {
  dolotsav: "Dolotsav",
  "pragatya-divas-maha-bhog": "Pragatya Divas / Maha Bhog",
  "nand-mahotsav": "Nand Mahotsav",
  "adhikmas-hindola": "Adhikmas / Hindola",
  annakut: "Annakut",
} as const;
export const festivalKeys = Object.keys(festivalGroups) as Array<keyof typeof festivalGroups>;
export const dailySeva = [
  {slug: "mangla-seva", title: "Mangla Seva", amount: 8400},
  {slug: "palna-seva", title: "Palna Seva", amount: 15100},
  {slug: "silver-palna-seva", title: "Silver Palna Seva", amount: 20100},
  {slug: "rajbhog-seva", title: "Rajbhog Seva", amount: 30100},
  {slug: "gold-palna-seva", title: "Golden Palna Seva", amount: 25100},
  {slug: "shayan-seva", title: "Shayan Palna", amount: 10100},
  {slug: "whole-day-manorathi", title: "Whole Day Seva", amount: 40100},
] as const;
const common = [["Mukhya Manorathi", 100100], ["Sahayak Manorathi", 50100], ["Palana", 15100]] as const;
const options = {
  dolotsav: common,
  "pragatya-divas-maha-bhog": common,
  "nand-mahotsav": common,
  "adhikmas-hindola": [["Weekday Manorathi", 22500], ["Weekend Manorathi", 35100]],
  annakut: [["Mukhya Manorathi", 300100], ["Sahayak Manorathi", 200100], ["Sha-Sahayak Manorathi", 100100], ["Manorathi", 20100]],
} as const;
export const utsavOptions = festivalKeys.flatMap(festivalGroup => options[festivalGroup].map(([title, amount]) => ({
  title, amount, category: "utsav" as const, festivalGroup,
  slug: `utsav-${festivalGroup}-${title.toLowerCase().replaceAll(" ", "-")}`,
})));

export type CatalogPlanRecord = { _id: unknown; slug: string; title: string; fixedAmountsCents: number[]; amountType: string; status: string; category?: string; festivalGroup?: string; deletedAt?: unknown; displayOrder?: number };
export function buildClientCatalogPlan(records: CatalogPlanRecord[]) {
  const expected = [
    ...dailySeva.map((row, index) => ({...row, category: "daily_seva", festivalGroup: "", displayOrder: index + 1})),
    {slug: "mahaprasad-manorathi", title: "Mahaprasad Manorathi", amount: 50100, category: "general", festivalGroup: "", displayOrder: 20},
    ...utsavOptions.map((row, index) => ({...row, displayOrder: 100 + index})),
  ];
  return expected.map(row => {
    const matches = records.filter(record => record.slug === row.slug);
    if (matches.length > 1) throw new Error(`Duplicate slug: ${row.slug}`);
    const existing = matches[0];
    if (!existing && records.some(record => record.title.toLowerCase() === row.title.toLowerCase() && (record.festivalGroup || "") === row.festivalGroup))
      throw new Error(`Ambiguous title mapping: ${row.title}`);
    if (existing?.deletedAt) throw new Error(`Soft-deleted conflict: ${row.slug}`);
    if (!existing && dailySeva.some(item => item.slug === row.slug)) throw new Error(`Missing expected Daily Seva: ${row.slug}`);
    const proposed = {title: row.title, slug: row.slug, amountType: "fixed", fixedAmountsCents: [row.amount], category: row.category, festivalGroup: row.festivalGroup, displayOrder: row.displayOrder, status: "active"};
    const unchanged = existing && Object.entries(proposed).every(([key, value]) => JSON.stringify(existing[key as keyof CatalogPlanRecord]) === JSON.stringify(value));
    return {action: unchanged ? "retain" : existing ? "update" : "create", id: existing ? String(existing._id) : null, current: existing || null, proposed};
  });
}
