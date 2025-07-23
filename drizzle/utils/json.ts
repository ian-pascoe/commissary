import { customType } from "drizzle-orm/sqlite-core";
import SuperJSON from "superjson";

export const json = customType<{
  data: unknown;
  driverData: string;
}>({
  dataType: () => "text",
  toDriver: (value) => SuperJSON.stringify(value),
  fromDriver: (value) => SuperJSON.parse(value),
});
