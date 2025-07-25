import { init } from "@paralleldrive/cuid2";

const cuid = init({
  length: 10,
});

export const createId = (prefix?: string) => {
  return prefix ? `${prefix}${cuid()}` : cuid();
};
