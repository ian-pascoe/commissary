import { CloudIcon, CloudOffIcon, RefreshCwIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

type SyncStatusButtonProps = {
  syncStats?: {
    needsInitialSync: boolean;
    pendingChanges: {
      conversations: number;
      messages: number;
      total: number;
    };
  };
  isLoading: boolean;
  onManualSync: () => void;
};

export const SyncStatusButton = ({
  syncStats,
  isLoading,
  onManualSync,
}: SyncStatusButtonProps) => {
  if (!syncStats) return null;

  const { pendingChanges, needsInitialSync } = syncStats;
  const hasPendingChanges = pendingChanges.total > 0;

  // Determine icon and styling based on sync state
  const getIconAndStyles = () => {
    if (isLoading) {
      return {
        icon: <RefreshCwIcon className="h-5 w-5 animate-spin" />,
        className: "text-blue-500 hover:text-blue-600",
        tooltip: "Syncing...",
      };
    }

    if (hasPendingChanges) {
      return {
        icon: <CloudOffIcon className="h-5 w-5" />,
        className: "text-amber-500 hover:text-amber-600",
        tooltip: `${pendingChanges.total} unsaved change${pendingChanges.total !== 1 ? "s" : ""} - Click to sync`,
      };
    }

    return {
      icon: <CloudIcon className="h-5 w-5" />,
      className: "text-green-500 hover:text-green-600",
      tooltip: "All changes saved",
    };
  };

  const { icon, className, tooltip } = getIconAndStyles();
  const shouldShowButton = hasPendingChanges || needsInitialSync || isLoading;

  return (
    <div className="absolute top-4 right-4 z-10">
      <Button
        type="button"
        size="icon"
        onClick={shouldShowButton ? onManualSync : undefined}
        disabled={isLoading}
        className={cn(
          "relative rounded-lg bg-white/90 p-2 shadow-sm backdrop-blur-sm transition-all duration-200 hover:bg-white/95 hover:shadow-md disabled:cursor-not-allowed",
          className,
        )}
        title={tooltip}
      >
        {icon}

        {/* Badge for pending changes count */}
        {hasPendingChanges && !isLoading && (
          <span className="-right-1 -top-1 absolute flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 font-semibold text-white text-xs">
            {pendingChanges.total > 9 ? "9+" : pendingChanges.total}
          </span>
        )}
      </Button>
    </div>
  );
};
