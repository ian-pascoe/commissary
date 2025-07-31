import { ModelMultiselector } from "~/components/provider/model/model-multiselector";
import { Label } from "~/components/ui/label";
import { withForm } from "~/hooks/use-form";
import type { Provider } from "../form";

export const ProviderModelForm = withForm({
  defaultValues: {} as Provider,
  render: function Form({ form }) {
    return (
      <div className="flex flex-col gap-2">
        <Label className="text-lg">Models</Label>
        <div className="flex flex-col gap-4">
          <form.Subscribe selector={(state) => state.values.id}>
            {(id) => (
              <form.AppField name="models">
                {(field) => (
                  <div className="flex flex-col gap-1">
                    <ModelMultiselector
                      value={field.state.value ?? {}}
                      onChange={field.setValue}
                    />
                    <field.FieldError />
                  </div>
                )}
              </form.AppField>
            )}
          </form.Subscribe>
        </div>
      </div>
    );
  },
});
