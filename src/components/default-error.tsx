export function DefaultError({ error }: { error: Error }) {
  return (
    <div className="flex size-full items-center justify-center">
      <div className="error">Error: {error.message}</div>
    </div>
  );
}
