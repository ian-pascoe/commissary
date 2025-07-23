import { resolve, resourceDir } from "@tauri-apps/api/path";
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
  const resourceDirPath = await resourceDir();
  const migrationsDirPath = await resolve(resourceDirPath, "migrations");
  const migrationsDirFiles = await readDir(migrationsDirPath);
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
      const migrationPath = await resolve(
        migrationsDirPath,
        migrationFile.name,
      );
      const sql = await readTextFile(migrationPath);

      sqlite.execute(sql, []);
      sqlite.execute(
        /*sql*/ `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [hash, Date.now()],
      );
    }
  }

  console.info("Migrations complete");

  return Promise.resolve();
}
