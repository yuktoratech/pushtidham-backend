import {createHash} from "node:crypto";
import {Giving} from "../models/giving.js";
import {Event} from "../models/event.js";
import {GivingCategory} from "../models/giving-category.js";
import {ImageCleanup} from "../models/image-cleanup.js";
import type {ImageStorage} from "./image-storage.js";
import {log} from "../utils/logger.js";

const idFor = (url: string) => createHash("sha256").update(url).digest("hex");
export async function imageIsReferenced(url: string) {
  const references = await Promise.all([
    Giving.exists({image: url, deletedAt: null}),
    Event.exists({deletedAt: null, $or: [{image: url}, {"gallery.url": url}]}),
    GivingCategory.exists({image: url}),
  ]);
  return references.some(Boolean);
}

export class ImageCleanupService {
  constructor(private readonly storage?: ImageStorage) {}

  async schedule(urls: string[]) {
    const unique = [...new Set(urls.filter(url => /^https?:\/\//.test(url)))];
    for (const url of unique) await ImageCleanup.updateOne({_id: idFor(url)}, {
      $set: {url, nextAttemptAt: new Date(Date.now() + 5 * 60_000)},
      $setOnInsert: {leaseUntil: new Date(0)},
    }, {upsert: true});
    return unique;
  }

  async process(urls: string[]) {
    if (!this.storage) return;
    for (const url of urls) {
      const id = idFor(url);
      try {
        const job = await ImageCleanup.findOneAndUpdate({_id: id, leaseUntil: {$lte: new Date()}},
          {$set: {leaseUntil: new Date(Date.now() + 60_000)}}, {returnDocument: "after"});
        if (!job) continue;
        if (await imageIsReferenced(url)) {
          await ImageCleanup.updateOne({_id: id}, {$set: {leaseUntil: new Date(0), nextAttemptAt: new Date(Date.now() + 60 * 60_000)}});
          continue;
        }
        // False means external/protected/unverified; do not repeatedly attempt those.
        await this.storage.deleteManagedUrl(url);
        await ImageCleanup.deleteOne({_id: id});
      } catch {
        log("error", "catalog_image_cleanup_pending", {cleanupId: id});
        await ImageCleanup.updateOne({_id: id}, {$set: {leaseUntil: new Date(0), nextAttemptAt: new Date(Date.now() + 60_000)}})
          .catch(() => log("error", "catalog_image_cleanup_retry_failed", {cleanupId: id}));
      }
    }
  }

  async retryPending() {
    if (!this.storage) return;
    const jobs = await ImageCleanup.find({nextAttemptAt: {$lte: new Date()}, leaseUntil: {$lte: new Date()}})
      .sort({nextAttemptAt: 1}).limit(20).lean();
    await this.process(jobs.map(job => job.url));
  }
}
