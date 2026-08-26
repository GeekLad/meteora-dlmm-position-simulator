"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Share2 } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MeteoraPair } from "@/lib/meteora-api";

interface ShareButtonProps {
  currentPrice: number | '';
  initialPrice: number | '';
  selectedPool: MeteoraPair | null;
  wallet?: string | null;
  disabled?: boolean;
  compact?: boolean;
}

export function ShareButton({ currentPrice, initialPrice, selectedPool, wallet, disabled = false, compact = false }: ShareButtonProps) {
  const { toast } = useToast();

  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    setBaseUrl(window.location.origin + window.location.pathname);
  }, []);

  const shareUrl = useMemo(() => {
    if (!baseUrl) return '';
    const searchParams = new URLSearchParams();

    if (selectedPool) {
      searchParams.set('pool', selectedPool.address);
    }

    if (wallet) {
      searchParams.set('wallet', wallet);
    }

    if (currentPrice !== '' && currentPrice !== initialPrice) {
      searchParams.set('currentPrice', currentPrice.toString());
    }

    const queryString = searchParams.toString();
    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  }, [currentPrice, initialPrice, selectedPool, wallet, baseUrl]);

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast({
        title: "Copied to clipboard",
        description: "Share URL has been copied to your clipboard.",
      });
    } catch (error) {
      toast({
        title: "Failed to copy",
        description: "Unable to copy URL to clipboard. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <TooltipProvider>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <span className="inline-block">
            <Button
              variant="outline"
              size="sm"
              onClick={handleShare}
              disabled={disabled}
              className={compact ? "h-8 w-8 px-0 lg:h-9 lg:w-auto lg:px-3" : undefined}
              aria-label="Share"
            >
              <Share2 className={compact ? "h-4 w-4 lg:mr-2" : "mr-2 h-4 w-4"} />
              <span className={compact ? "hidden lg:inline" : undefined}>Share</span>
            </Button>
          </span>
        </TooltipTrigger>
        {disabled && (
          <TooltipContent side="bottom">
            <p>Select a pool or load a wallet to enable sharing</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}
