import * as z from "zod";

export const SignIn = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(1, "Password is required"),
});
export type SignInInput = z.input<typeof SignIn>;
export type SignIn = z.infer<typeof SignIn>;

export const SignUp = z
  .object({
    name: z.string().min(1, "Name is required"),
    email: z.email({ message: "Invalid email address" }),
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type SignUpInput = z.input<typeof SignUp>;
export type SignUp = z.infer<typeof SignUp>;
