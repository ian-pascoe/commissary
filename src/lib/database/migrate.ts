import { BaseDirectory, join } from "@tauri-apps/api/path";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import type Database from "@tauri-apps/plugin-sql";

export type ProxyMigrator = (migrationQueries: string[]) => Promise<void>;

/**
 * Executes database migrations.
 *
 * @param db The database instance.
 * @returns A promise that resolves when the migrations are complete.
 */
export async function migrate(sqlite: Database) {
  console.log("Running migrations...");

  console.log("Reading migrations from the 'migrations' directory...");
  const migrationsDirFiles = await readDir("migrations", {
    baseDir: BaseDirectory.Resource,
  });
  console.log(`Found ${migrationsDirFiles.length} migration files.`);

  let migrationsFiles = migrationsDirFiles.filter(
    (file) => file.isFile && file.name.endsWith(".sql"),
  );

  // sort migrations by the first 4 characters of the file name
  migrationsFiles = migrationsFiles.sort((a, b) => {
    const aHash = a.name.replace(".sql", "").slice(0, 4);
    const bHash = b.name.replace(".sql", "").slice(0, 4);

    if (aHash && bHash) {
      return aHash.localeCompare(bHash);
    }

    return 0;
  });

  console.log("Creating migrations table if it does not exist...");
  await sqlite.execute(
    /*sql*/ `
		  CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL UNIQUE,
        created_at numeric
		  );
	  `,
    [],
  );

  for (const migrationFile of migrationsFiles) {
    const hash = migrationFile.name.replace(".sql", "");

    const dbMigrations = (await sqlite.select(
      /*sql*/ `SELECT id, hash, created_at FROM "__drizzle_migrations" ORDER BY created_at DESC`,
    )) as unknown as { id: number; hash: string; created_at: number }[];

    const hasBeenRun = (hash: string) =>
      dbMigrations.find((dbMigration) => {
        return dbMigration.hash === hash;
      });

    if (hash && hasBeenRun(hash) === undefined) {
      const sql = await readTextFile(
        await join("migrations", migrationFile.name),
        { baseDir: BaseDirectory.Resource },
      );

      sqlite.execute(sql, []);
      sqlite.execute(
        /*sql*/ `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [hash, Date.now()],
      );
    }
  }

  console.log("Migrations complete");

  return Promise.resolve();
}
