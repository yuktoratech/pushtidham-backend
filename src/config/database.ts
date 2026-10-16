import mongoose from "mongoose";
export async function connectDatabase(uri: string) {
  await mongoose.connect(uri, {
    dbName: process.env.MONGODB_DATABASE || undefined,
    serverSelectionTimeoutMS: 10000,
    autoIndex: process.env.NODE_ENV !== "production",
  });
}
