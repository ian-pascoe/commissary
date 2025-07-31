import { useMutation } from "@tanstack/react-query";
import { eq } from "drizzle-orm";
import { type ComponentProps, useState } from "react";
import type * as z from "zod";
import { useForm } from "~/hooks/use-form";
import { useLocalDb } from "~/hooks/use-local-db";
import { UpdateConversation } from "~/schemas/conversation";
import { conversations as conversationsTable } from "~~/drizzle/local/schema";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

export const EditConversation = UpdateConversation;
export type EditConversation = z.infer<typeof EditConversation>;

export type EditConversationButtonProps = ComponentProps<typeof Button> & {
  conversationId: string;
  currentTitle: string;
  onSuccess?: () => void;
};

export const EditConversationButton = ({
  children,
  conversationId,
  currentTitle,
  onSuccess,
  ...props
}: EditConversationButtonProps) => {
  const db = useLocalDb();
  const [isOpen, setIsOpen] = useState(false);

  const submitMutation = useMutation({
    mutationFn: async (input: EditConversation) => {
      const data = EditConversation.parse(input);
      await db
        .update(conversationsTable)
        .set(data)
        .where(eq(conversationsTable.id, conversationId));
      return data;
    },
    onSuccess: () => {
      setIsOpen(false);
      onSuccess?.();
    },
  });

  const form = useForm({
    defaultValues: {
      title: currentTitle,
    } as EditConversation,
    validators: {
      onChange: EditConversation,
    },
    onSubmit: ({ value }) => submitMutation.mutateAsync(value),
  });

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button {...props}>{children ?? "Edit Conversation"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Conversation</DialogTitle>
          <DialogDescription>
            Update the conversation title
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="flex flex-col gap-6"
        >
          <div className="flex flex-col gap-4">
            <form.AppField name="title">
              {(field) => (
                <div className="flex flex-col gap-1">
                  <field.Label>Title</field.Label>
                  <field.Input
                    value={field.state.value || ""}
                    onChange={(e) => field.setValue(e.target.value)}
                    placeholder="Enter conversation title"
                  />
                  <field.FieldError />
                </div>
              )}
            </form.AppField>
          </div>
          <DialogFooter>
            <form.Subscribe
              selector={(s) => ({
                isSubmitting: s.isSubmitting,
                canSubmit: s.canSubmit,
              })}
            >
              {({ isSubmitting, canSubmit }) => (
                <Button type="submit" disabled={isSubmitting || !canSubmit}>
                  {isSubmitting ? "Saving..." : "Save"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};