"use client";

import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export type AIConversationProps = ComponentProps<typeof StickToBottom>;

export const AIConversation = ({
  className,
  ...props
}: AIConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-auto", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type AIConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const AIConversationContent = ({
  className,
  ...props
}: AIConversationContentProps) => (
  <StickToBottom.Content className={cn("p-4", className)} {...props} />
);

export type AIConversationScrollButtonProps = ComponentProps<typeof Button>;

export const AIConversationScrollButton = ({
  children,
  className,
  onClick,
  ...props
}: AIConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full",
          className,
        )}
        onClick={(e) => {
          handleScrollToBottom();
          onClick?.(e);
        }}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        {children || <ArrowDownIcon className="size-4" />}
      </Button>
    )
  );
};
