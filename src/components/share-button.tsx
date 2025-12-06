"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Share2 } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MeteoraPair } from "@/lib/meteora-api";

type PartialSimulationParams = {
  binStep: number | '';
  initialPrice: number | '';
  baseAmount: number | '';
  quoteAmount: number | '';
  lowerPrice: number | '';
  upperPrice: number | '';
  strategy: 'spot' | 'bid-ask' | 'curve';
};

interface ShareButtonProps {
  params: PartialSimulationParams;
  currentPrice: number | '';
  selectedPool: MeteoraPair | null;
  autoFill: boolean;
  disabled?: boolean;
}

export function ShareButton({ params, currentPrice, selectedPool, autoFill, disabled = false }: ShareButtonProps) {
  const { toast } = useToast();

  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    setBaseUrl(window.location.origin + window.location.pathname);
  }, []);

  const shareUrl = useMemo(() => {
    if (!baseUrl) return '';
    const searchParams = new URLSearchParams();

    // Only include non-default values
    if (selectedPool) {
      searchParams.set('pool', selectedPool.address);
    }

    if (params.binStep !== '') {
      searchParams.set('binStep', params.binStep.toString());
    }

    if (params.strategy !== 'spot') {
      searchParams.set('strategy', params.strategy);
    }

    if (params.lowerPrice !== '') {
      searchParams.set('lowerPrice', params.lowerPrice.toString());
    }

    if (params.upperPrice !== '') {
      searchParams.set('upperPrice', params.upperPrice.toString());
    }

    if (params.baseAmount !== '') {
      searchParams.set('baseAmount', params.baseAmount.toString());
    }

    if (params.quoteAmount !== '') {
      searchParams.set('quoteAmount', params.quoteAmount.toString());
    }

    if (params.initialPrice !== '') {
      searchParams.set('initialPrice', params.initialPrice.toString());
    }

    if (currentPrice !== '' && currentPrice !== params.initialPrice) {
      searchParams.set('currentPrice', currentPrice.toString());
    }

    if (autoFill) {
      searchParams.set('autoFill', 'true');
    }

    const queryString = searchParams.toString();
    return queryString ? `${baseUrl}?${queryString}` : baseUrl;
  }, [params, currentPrice, selectedPool, autoFill]);

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
            <Button variant="outline" size="sm" onClick={handleShare} disabled={disabled}>
              <Share2 className="mr-2 h-4 w-4" />
              Share
            </Button>
          </span>
        </TooltipTrigger>
        {disabled && (
          <TooltipContent side="bottom">
            <p>Complete all parameters to enable sharing</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}