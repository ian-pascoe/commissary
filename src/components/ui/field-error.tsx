import { useFieldContext } from "~/hooks/use-form";

export const FieldError = () => {
  const field = useFieldContext();
  if (!field.state.meta.errors) return null;
  return (
    <div className="text-red-500 text-sm">
      {field.state.meta.errors.map((error) => (
        <p key={error}>{error.message}</p>
      ))}
    </div>
  );
};
