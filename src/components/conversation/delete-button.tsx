import { useMutation } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { Trash } from "lucide-react";
import type { ComponentProps } from "react";
import { useLocalDb } from "~/hooks/use-local-db";
import { conversations as conversationsTable } from "~~/drizzle/local/schema";
import { Button } from "../ui/button";

export type DeleteConversationButtonProps = ComponentProps<typeof Button> & {
  conversationId: string;
  onSuccess?: () => void;
};

export const DeleteConversationButton = ({
  children,
  conversationId,
  onSuccess,
  ...props
}: DeleteConversationButtonProps) => {
  const navigate = useNavigate();
  const { id: currentConversationId } = useParams({ strict: false });
  const db = useLocalDb();

  const deleteMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      await db
        .delete(conversationsTable)
        .where(eq(conversationsTable.id, conversationId));
      return conversationId;
    },
    onSuccess: (conversationId) => {
      if (currentConversationId === conversationId) {
        navigate({ to: "/chat" });
      }
      onSuccess?.();
    },
  });

  return (
    <Button
      {...props}
      onClick={() => deleteMutation.mutate(conversationId)}
    >
      {children ?? <Trash size={16} />}
    </Button>
  );
};