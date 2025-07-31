import { useStore } from "@tanstack/react-form";
import { useEffect } from "react";
import { Label } from "~/components/ui/label";
import { withForm } from "~/hooks/use-form";
import type { Provider } from "../form";
import { AnthropicOauthForm } from "./anthropic-oauth-form";

export const ProviderAuthForm = withForm({
  defaultValues: {} as Provider,
  render: function Form({ form }) {
    return (
      <div className="flex flex-col gap-2">
        <Label className="text-lg">Authentication</Label>
        <div className="flex flex-col gap-4">
          <form.Subscribe selector={(state) => state.values.id}>
            {function Comp(id) {
              const authType = useStore(
                form.store,
                (state) => state.values.auth?.type,
              );
              useEffect(() => {
                switch (id) {
                  case "openai":
                  case "google":
                    form.setFieldValue("auth.type", "api-key");
                    break;
                  case "anthropic":
                    if (!authType) {
                      form.setFieldValue("auth.type", "oauth");
                    }
                    break;
                  default:
                    if (
                      !authType ||
                      authType === "aws" ||
                      authType === "oauth"
                    ) {
                      form.setFieldValue("auth", undefined);
                    }
                    break;
                }
              }, [id, authType, form]);

              switch (id) {
                // OpenAI and Google both only use API keys for auth
                case "openai":
                case "google":
                  return (
                    <form.AppField name="auth.apiKey">
                      {(field) => (
                        <div className="flex flex-col gap-1">
                          <field.Label>API Key</field.Label>
                          <field.Input
                            value={field.state.value}
                            onChange={(e) => field.setValue(e.target.value)}
                          />
                        </div>
                      )}
                    </form.AppField>
                  );

                case "anthropic": {
                  return (
                    <>
                      <form.AppField name="auth.type">
                        {(field) => (
                          <div className="flex flex-col gap-1">
                            <field.Label>Authentication Type</field.Label>
                            <field.Select
                              value={field.state.value || "oauth"}
                              onValueChange={(value) =>
                                field.setValue(
                                  value as typeof field.state.value,
                                )
                              }
                            >
                              <field.SelectTrigger>
                                <field.SelectValue placeholder="Select Auth Type" />
                              </field.SelectTrigger>
                              <field.SelectContent>
                                <field.SelectItem value="oauth">
                                  OAuth
                                </field.SelectItem>
                                <field.SelectItem value="api-key">
                                  API Key
                                </field.SelectItem>
                              </field.SelectContent>
                            </field.Select>
                          </div>
                        )}
                      </form.AppField>
                      <form.Subscribe
                        selector={(state) => state.values.auth?.type}
                      >
                        {(_authType) => {
                          const authType = _authType || "oauth";
                          switch (authType) {
                            case "api-key":
                              return (
                                <form.AppField name="auth.apiKey">
                                  {(field) => (
                                    <div className="flex flex-col gap-1">
                                      <field.Label>API Key</field.Label>
                                      <field.Input
                                        value={field.state.value}
                                        onChange={(e) =>
                                          field.setValue(e.target.value)
                                        }
                                      />
                                    </div>
                                  )}
                                </form.AppField>
                              );

                            case "oauth":
                              return <AnthropicOauthForm form={form} />;

                            default:
                              return null;
                          }
                        }}
                      </form.Subscribe>
                    </>
                  );
                }

                default:
                  return (
                    <>
                      <form.AppField name="auth.type">
                        {(field) => (
                          <div className="flex flex-col gap-1">
                            <field.Label>Authentication Type</field.Label>
                            <field.Select
                              value={field.state.value}
                              onValueChange={(value) => {
                                if (value === "none") {
                                  form.setFieldValue("auth", undefined);
                                } else {
                                  field.setValue(
                                    value as typeof field.state.value,
                                  );
                                }
                              }}
                            >
                              <field.SelectTrigger>
                                <field.SelectValue placeholder="None" />
                              </field.SelectTrigger>
                              <field.SelectContent>
                                <field.SelectItem value="none">
                                  None
                                </field.SelectItem>
                                <field.SelectItem value="api-key">
                                  API Key
                                </field.SelectItem>
                              </field.SelectContent>
                            </field.Select>
                          </div>
                        )}
                      </form.AppField>
                      <form.Subscribe
                        selector={(state) => state.values.auth?.type}
                      >
                        {(authType) =>
                          authType === "api-key" && (
                            <form.AppField name="auth.apiKey">
                              {(field) => (
                                <div className="flex flex-col gap-1">
                                  <field.Label>API Key</field.Label>
                                  <field.Input
                                    value={field.state.value}
                                    onChange={(e) =>
                                      field.setValue(
                                        e.target.value || undefined,
                                      )
                                    }
                                  />
                                </div>
                              )}
                            </form.AppField>
                          )
                        }
                      </form.Subscribe>
                    </>
                  );
              }
            }}
          </form.Subscribe>
        </div>
      </div>
    );
  },
});
