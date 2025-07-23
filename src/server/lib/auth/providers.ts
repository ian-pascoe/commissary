import { PasswordProvider } from "@openauthjs/openauth/provider/password";
import { PasswordUI } from "@openauthjs/openauth/ui/password";

export const providers = {
  password: PasswordProvider(
    PasswordUI({
      validatePassword: (password) => {
        if (password.length < 8) {
          return "Password must be at least 8 characters long";
        }
        if (password.length > 128) {
          return "Password must be at most 128 characters long";
        }
        if (!/[A-Z]/.test(password)) {
          return "Password must contain at least one uppercase letter";
        }
        if (!/[a-z]/.test(password)) {
          return "Password must contain at least one lowercase letter";
        }
        if (!/[0-9]/.test(password)) {
          return "Password must contain at least one number";
        }
        if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
          return "Password must contain at least one special character";
        }
        return undefined;
      },
      sendCode: async (email, code) => {
        // TODO: Implement email sending logic
      },
    }),
  ),
};
