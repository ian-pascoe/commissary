import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type * as z from "zod";
import { users } from "~/drizzle/schema";

export const User = createSelectSchema(users);
export type User = z.infer<typeof User>;

export const CreateUser = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  emailVerified: true,
  emailVerifiedAt: true,
});
export type CreateUserInput = z.input<typeof CreateUser>;
export type CreateUser = z.infer<typeof CreateUser>;

export const UpdateUser = createUpdateSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  emailVerified: true,
  emailVerifiedAt: true,
});
export type UpdateUserInput = z.input<typeof UpdateUser>;
export type UpdateUser = z.infer<typeof UpdateUser>;
