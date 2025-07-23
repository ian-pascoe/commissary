import { formatISO, parseISO } from "date-fns";
import { customType } from "drizzle-orm/sqlite-core";

export const timestamp = customType<{
  data: Date;
  driverData: string;
}>({
  dataType: () => "string",
  toDriver: (value) => formatISO(value, { representation: "complete" }),
  fromDriver: (value) => parseISO(value),
});
