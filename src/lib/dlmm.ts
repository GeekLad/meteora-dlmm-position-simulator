

export type Strategy = 'spot' | 'bid-ask' | 'curve';

export interface SimulationParams {
  binStep: number;
  initialPrice: number;
  baseAmount: number;
  quoteAmount: number;
  lowerPrice: number;
  upperPrice: number;
  strategy: Strategy;
}

export interface SimulatedBin {
  id: number;
  price: number;
  initialTokenType: 'base' | 'quote';
  initialAmount: number;
  initialValueInQuote: number;
  displayValue: number;
  currentTokenType: 'base' | 'quote';
  currentAmount: number;
  currentValueInQuote: number;
}


export interface Analysis {
  totalValueInQuote: number;
  totalBase: number;
  totalQuote: number;
  totalBins: number;
  baseBins: number;
  quoteBins: number;
}

export const getPriceFromId = (id: number, binStep: number): number => {
  const basis = 1 + binStep / 10000;
  return basis ** (id - 262144);
};

export const getIdFromPrice = (price: number, binStep: number): number => {
    if (price <= 0 || binStep <= 0) return 0;
    const basis = 1 + binStep / 10000;
    return Math.floor(Math.log(price) / Math.log(basis)) + 262144;
};


export function getInitialBins(params: SimulationParams): SimulatedBin[] {
  const { binStep, initialPrice, baseAmount, quoteAmount, lowerPrice, upperPrice, strategy } = params;
  if (lowerPrice <= 0 || upperPrice <= lowerPrice || binStep <= 0 || initialPrice <= 0) {
    return [];
  }

  // Use floor for lower bound and ceil for upper bound to ensure the range includes both prices
  const minId = getIdFromPrice(lowerPrice, binStep);
  const basis = 1 + binStep / 10000;
  const maxIdExact = Math.log(upperPrice) / Math.log(basis) + 262144;
  const maxId = Math.ceil(maxIdExact);
  const initialPriceId = getIdFromPrice(initialPrice, binStep);
  
  const priceValid = initialPriceId >= minId && initialPriceId <= maxId;
  if (!priceValid) {
     // Allow for out of range initial price for one-sided liquidity
  }

  let bins: SimulatedBin[] = [];
  
  const quoteBins: {id: number, price: number}[] = [];
  const baseBins: {id: number, price: number}[] = [];

  for (let id = minId; id <= maxId; id++) {
    const price = getPriceFromId(id, binStep);
    bins.push({
      id,
      price,
      initialTokenType: 'base', // Will be determined later
      initialAmount: 0,
      initialValueInQuote: 0,
      displayValue: 0,
      currentTokenType: 'base', // Placeholder
      currentAmount: 0,
      currentValueInQuote: 0,
    });
    if (id <= initialPriceId) {
      quoteBins.push({id, price});
    }
    if (id > initialPriceId) {
      baseBins.push({id, price});
    }
  }
  
  // Distribute Quote
  if (quoteAmount > 0 && quoteBins.length > 0) {
    let totalWeight = 0;

    const weights = quoteBins.map(qb => {
      const dist = initialPriceId - qb.id;
      let weight: number;

      switch(strategy) {
        case 'curve':
          const maxDist = initialPriceId - minId;
          weight = maxDist > 0 ? maxDist - dist : 1;
          break;
        case 'bid-ask':
          weight = dist + 1;
          break;
        case 'spot':
        default:
          weight = 1;
          break;
      }
      totalWeight += weight;
      return { id: qb.id, weight };
    });
    
    if (totalWeight > 0) {
      weights.forEach(({ id, weight }) => {
        const binToUpdate = bins.find(b => b.id === id)!;
        const amount = (quoteAmount * weight) / totalWeight;
        binToUpdate.initialTokenType = 'quote';
        binToUpdate.initialAmount = amount;
        binToUpdate.initialValueInQuote = amount;
      });
    }
  }

  // Distribute Base
  if (baseAmount > 0 && baseBins.length > 0) {
    if (strategy === 'spot') {
      // For spot: equal value per bin at the bin price
      const constant = quoteBins.length > 0 ? quoteAmount / quoteBins.length : 0;
      baseBins.forEach(bb => {
        const binToUpdate = bins.find(b => b.id === bb.id)!;
        const amount = constant / bb.price;
        binToUpdate.initialTokenType = 'base';
        binToUpdate.initialAmount = amount;
        // Each bin has equal value at its bin price
        binToUpdate.initialValueInQuote = constant;
      });
    } else {
      let totalValueWeight = 0;
      const totalValue = baseAmount * initialPrice;

      const weights = baseBins.map(bb => {
          const dist = bb.id - initialPriceId;
          let weight: number;
          switch(strategy) {
            case 'curve':
              const maxDist = maxId - initialPriceId;
              weight = maxDist > 0 ? maxDist - dist : 1;
              break;
            case 'bid-ask':
              weight = dist + 1;
              break;
            default:
              weight = 1;
              break;
          }
          totalValueWeight += weight;
          return { id: bb.id, weight, price: bb.price };
      });

      if (totalValueWeight > 0) {
          weights.forEach(({ id, weight, price }) => {
              const binToUpdate = bins.find(b => b.id === id)!;
              // For base tokens, we distribute the total value (at initial price), then find amount
              const targetValue = totalValue * (weight / totalValueWeight);
              const amount = targetValue / price;

              binToUpdate.initialTokenType = 'base';
              binToUpdate.initialAmount = amount;
              // Store the target value as initial value for this distribution
              binToUpdate.initialValueInQuote = targetValue;
          });
      }
    }
  }
  
  
  // Normalization step to correct for floating point inaccuracies
  const calculatedBaseSum = bins.reduce((sum, bin) => bin.initialTokenType === 'base' ? sum + bin.initialAmount : sum, 0);
  const calculatedQuoteSum = bins.reduce((sum, bin) => bin.initialTokenType === 'quote' ? sum + bin.initialAmount : sum, 0);

  if (baseAmount > 0 && calculatedBaseSum > 0) {
    const baseCorrectionFactor = baseAmount / calculatedBaseSum;
    bins.forEach(bin => {
      if (bin.initialTokenType === 'base') {
        bin.initialAmount *= baseCorrectionFactor;
        // Preserve the distribution's value structure
        if (strategy === 'spot') {
          // For spot: maintain equal value per bin at bin price
          bin.initialValueInQuote = bin.initialAmount * bin.price;
        } else {
          // For bid-ask/curve: maintain market-price-based valuation
          bin.initialValueInQuote *= baseCorrectionFactor;
        }
      }
    });
  }

  if (quoteAmount > 0 && calculatedQuoteSum > 0) {
    const quoteCorrectionFactor = quoteAmount / calculatedQuoteSum;
    bins.forEach(bin => {
      if (bin.initialTokenType === 'quote') {
        bin.initialAmount *= quoteCorrectionFactor;
        bin.initialValueInQuote = bin.initialAmount;
      }
    });
  }

  // Set displayValue for chart visualization. This MUST reflect the initial quote value.
  bins.forEach(bin => {
    bin.displayValue = bin.initialValueInQuote;
  });

  return bins.sort((a, b) => a.price - b.price);
}


export function runSimulation(initialBins: SimulatedBin[], currentPrice: number, initialPrice: number): { simulatedBins: SimulatedBin[], analysis: Analysis } {
  if (!initialBins || initialBins.length === 0) {
    return {
      simulatedBins: [],
      analysis: { totalValueInQuote: 0, totalBase: 0, totalQuote: 0, totalBins: 0, baseBins: 0, quoteBins: 0 }
    };
  }

  const simulatedBins = initialBins.map(bin => {
    const simBin: SimulatedBin = JSON.parse(JSON.stringify(bin)); // Deep copy

    if (simBin.initialAmount <= 0) {
      simBin.currentAmount = 0;
      simBin.currentValueInQuote = 0;
      simBin.currentTokenType = simBin.initialTokenType;
      simBin.displayValue = 0;
      return simBin;
    }

    // Determine current token type based on price
    if (currentPrice > simBin.price) { // Price moved above the bin, should be quote
        simBin.currentTokenType = 'quote';
        if (simBin.initialTokenType === 'base') {
            // Base converted to quote at bin price
            simBin.currentAmount = simBin.initialAmount * simBin.price;
        } else {
            simBin.currentAmount = simBin.initialAmount;
        }
    } else { // Price at or below the bin, should be base
        simBin.currentTokenType = 'base';
        if (simBin.initialTokenType === 'quote') {
            // Quote converted to base at bin price
            simBin.currentAmount = simBin.initialAmount / simBin.price;
        } else {
            simBin.currentAmount = simBin.initialAmount;
        }
    }

    // Value the current holdings at current market price
    if (simBin.currentTokenType === 'base') {
        simBin.currentValueInQuote = simBin.currentAmount * currentPrice;
    } else {
        simBin.currentValueInQuote = simBin.currentAmount;
    }

    // The displayValue from getInitialBins is static and represents the initial distribution shape.
    // We don't change it during simulation.

    return simBin;
  });

  const analysis = simulatedBins.reduce<Analysis>((acc, bin) => {
      if (bin.currentAmount > 1e-12) { // Tolerance for floating point dust
        acc.totalValueInQuote += bin.currentValueInQuote;
        if (bin.currentTokenType === 'base') {
          acc.totalBase += bin.currentAmount;
          acc.baseBins += 1;
        } else {
          acc.totalQuote += bin.currentAmount;
          acc.quoteBins += 1;
        }
      }
      return acc;
  }, { totalValueInQuote: 0, totalBase: 0, totalQuote: 0, totalBins: initialBins.filter(b => b.initialAmount > 0).length, baseBins: 0, quoteBins: 0 });

  return { simulatedBins, analysis };
}
