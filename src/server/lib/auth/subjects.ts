import { createSubjects } from "@openauthjs/openauth/subject";
import { User } from "~/schemas/user";

export const subjects = createSubjects({
  user: User,
});
