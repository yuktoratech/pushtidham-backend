import "dotenv/config";
import {resolve, dirname, basename} from "node:path";
import {spawnSync} from "node:child_process";
import {MongoClient} from "mongodb";
import {DATABASE, CONFIRM_APPLY, CONFIRM_ROLLBACK, MigrationError, applyCatalog, rollbackCatalog} from "./lib/client-catalog-migration.js";

async function main() {
  const [mode,...args] = process.argv.slice(2);
  if (mode === "--help" || args.includes("--help")) {
    console.log(`Mode: apply or rollback. Required: --database ${DATABASE} --host <exact Atlas SRV hostname> --backup .local-migrations/client-catalog-v1.ejson --confirm <confirmation>.\nApply confirmation: ${CONFIRM_APPLY}\nRollback confirmation: ${CONFIRM_ROLLBACK}`);
    return;
  }
  if (mode !== "apply" && mode !== "rollback") throw new MigrationError("Choose apply or rollback explicitly");
  const flags = new Map<string,string>();
  for (let i=0;i<args.length;i+=2) {
    const key=args[i],value=args[i+1];
    if (!key || !["--database","--host","--backup","--confirm"].includes(key) || !value || flags.has(key)) throw new MigrationError("Invalid, missing or duplicate arguments");
    flags.set(key,value);
  }
  if (flags.size !== 4) throw new MigrationError("All four execution arguments are required");
  if (process.env.NODE_ENV !== "development" || process.env.MONGODB_DATABASE !== DATABASE || flags.get("--database") !== DATABASE) throw new MigrationError("Development and the exact target database are required");
  const uri=process.env.MONGODB_URI;
  if (!uri) throw new MigrationError("Configured MongoDB URI is missing");
  let endpoint: URL;
  try {endpoint=new URL(uri);} catch {throw new MigrationError("Configured MongoDB URI is invalid");}
  if (endpoint.protocol !== "mongodb+srv:" || !endpoint.hostname.endsWith(".mongodb.net") || endpoint.hostname !== flags.get("--host")) throw new MigrationError("Confirm the exact configured Atlas SRV hostname");
  if (endpoint.pathname && endpoint.pathname !== "/" && endpoint.pathname !== `/${DATABASE}`) throw new MigrationError("URI database conflicts with the approved target");
  const confirmation=flags.get("--confirm")!;
  if (confirmation !== (mode === "apply" ? CONFIRM_APPLY : CONFIRM_ROLLBACK)) throw new MigrationError("Incorrect execution confirmation");
  const backupFile=resolve(flags.get("--backup")!);
  if (dirname(backupFile) !== resolve(".local-migrations") || !/^[a-zA-Z0-9._-]+\.ejson$/.test(basename(backupFile))) throw new MigrationError("Use a direct .ejson backup file inside .local-migrations");
  const ignored=spawnSync("git",["check-ignore","--quiet","--",backupFile],{stdio:"ignore"});
  if (ignored.status !== 0) throw new MigrationError("Backup path must be Git-ignored");
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:10000});
  try {
    await client.connect();
    const options={database:DATABASE,host:endpoint.hostname,confirmation,backupFile};
    const result=mode === "apply" ? await applyCatalog(client,options) : await rollbackCatalog(client,options);
    console.log(JSON.stringify({database:DATABASE,...result,backupFile}));
  } finally {await client.close();}
}
main().catch(error=>{
  // Do not print driver errors: they can include connection details. A commit
  // acknowledgement failure may have an uncertain outcome; keep the manifest.
  console.error(error instanceof MigrationError ? error.message : "Migration failed. Preserve the backup; verify database state before retrying. No automatic cleanup is performed.");
  process.exitCode=1;
});
