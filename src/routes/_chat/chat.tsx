import { createFileRoute } from "@tanstack/react-router";
import { ConversationWindow } from "~/components/conversation/window";

export const Route = createFileRoute("/_chat/chat")({
  component: RouteComponent,
});

function RouteComponent() {
  return <ConversationWindow />;
}
