import bcrypt from "bcrypt";
import mongoose from "mongoose";
import { z } from "zod";
import { loadConfig } from "../src/config/env.js";
import { connectDatabase } from "../src/config/database.js";
import { User } from "../src/models/user.js";
import { Giving } from "../src/models/giving.js";
import { Event } from "../src/models/event.js";
import { password } from "../src/validators/auth.js";
import { email } from "../src/validators/common.js";
import { BCRYPT_COST } from "../src/constants/domain.js";
try {
  const config = loadConfig();
  const admin = z
    .object({ name: z.string().trim().min(1).max(120), email, password })
    .parse({
      name: config.ADMIN_SEED_NAME,
      email: config.ADMIN_SEED_EMAIL,
      password: config.ADMIN_SEED_PASSWORD,
    });
  await connectDatabase(config.MONGODB_URI);
  await User.init();
  const existing = await User.findOne({ email: admin.email });
  if (existing) {
    if (existing.role !== "admin")
      throw new Error("Seed email already belongs to a donor");
    console.log("Existing admin retained; password and status unchanged");
  } else {
    await User.create({
      name: admin.name,
      email: admin.email,
      passwordHash: await bcrypt.hash(admin.password, BCRYPT_COST),
      role: "admin",
      status: "active",
    });
    console.log("Admin created");
  }
  if (config.NODE_ENV === "development") {
    await Promise.all([Giving.init(), Event.init()]);
    for (const entry of [
      {
        title: "General Support",
        slug: "general-support",
        amountType: "fixed_and_custom",
        fixedAmountsCents: [2500, 5000, 10000],
      },
      {
        title: "Temple Service",
        slug: "temple-service",
        amountType: "custom",
        fixedAmountsCents: [],
      },
    ])
      await Giving.updateOne(
        { slug: entry.slug },
        { $setOnInsert: { ...entry, status: "active", displayOrder: 0 } },
        { upsert: true, runValidators: true },
      );
    await Event.updateOne(
      { slug: "community-gathering" },
      {
        $setOnInsert: {
          title: "Community Gathering",
          slug: "community-gathering",
          shortDescription: "Development sample event",
          description: "Sample for future API integration",
          startsAt: new Date(Date.now() + 30 * 86400000),
          location: "Temple",
          status: "published",
        },
      },
      { upsert: true, runValidators: true },
    );
    console.log("Development samples inserted where missing");
  }
} catch {
  console.error(
    "Seed failed; check configuration and ensure seed email is not a donor account",
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
