import type { ColumnDef } from "@tanstack/react-table";
import type { FileUIPart } from "ai";
import { useMemo } from "react";
import { useChat } from "~/contexts/chat";
import { Checkbox } from "../ui/checkbox";
import { DataTable, DataTableColumnHeader } from "../ui/data-table";

const columns: ColumnDef<FileUIPart>[] = [
  {
    id: "select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && "indeterminate")
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: "filename",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="File Name" />
    ),
  },
  {
    accessorKey: "mediaType",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="File Type" />
    ),
  },
];

export const ConversationFilesTable = () => {
  const { messages } = useChat((ctx) => ({
    messages: ctx.messages,
  }));

  const fileParts = useMemo(
    () =>
      messages.flatMap((msg) =>
        msg.parts.filter((part) => part.type === "file"),
      ),
    [messages],
  );

  return (
    <div className="size-full overflow-y-auto p-2">
      <DataTable columns={columns} data={fileParts} />
    </div>
  );
};
