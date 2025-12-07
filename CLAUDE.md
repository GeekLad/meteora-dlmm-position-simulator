# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Next.js web application that simulates Meteora DLMM (Dynamic Liquidity Market Maker) positions. Users can configure liquidity positions with various parameters and interactively visualize how price movements affect their position value across discrete price bins.

Live demo: https://geeklad.github.io/meteora-dlmm-position-simulator

## Development Commands

- `npm run dev` - Start development server on port 9002 with Turbopack
- `npm run build` - Build for production (static export)
- `npm start` - Start production server
- `npm run lint` - Run ESLint
- `npm run typecheck` - Run TypeScript type checking without emitting files
- `npm run genkit:dev` - Start Genkit development server
- `npm run genkit:watch` - Start Genkit with file watching

## Architecture

### Core DLMM Simulation Logic (`src/lib/dlmm.ts`)

The heart of the application implements the DLMM bin-based liquidity model:

- **Bin ID System**: Uses a reference point of 262144 to convert between prices and discrete bin IDs
- **Price Calculation**: `getPriceFromId()` and `getIdFromPrice()` convert between bin IDs and prices using the formula: `price = (1 + binStep/10000)^(id - 262144)`
- **Liquidity Distribution Strategies**:
  - `spot`: Uniform distribution across all bins
  - `bid-ask`: Triangular distribution, concentrated toward initial price
  - `curve`: Curved distribution with smooth concentration
- **Simulation Flow**:
  1. `getInitialBins()` - Distributes base/quote tokens across bins based on strategy
  2. `runSimulation()` - Simulates token swaps as price moves, updating bin contents
  3. Bins automatically convert between base/quote tokens as price crosses them

### Main Component (`src/components/dlmm-simulator.tsx`)

Single-page application with three main sections:
1. **Input Panel**: Pool parameters (bin step) and liquidity position (strategy, price range, token amounts, initial price)
2. **Interactive Chart**: Visualizes liquidity distribution with draggable price handles
3. **Analysis Panel**: Real-time metrics (position value, profit/loss, token counts, bin statistics)

State management uses React hooks with derived state via `useMemo` to recalculate bins and simulations only when necessary.

### Key Concepts

- **Bins**: Discrete price ranges that hold either base or quote tokens
- **Token Conversion**: As current price moves above a bin's price, base tokens convert to quote; below converts quote to base
- **Display Values**: `displayValue` represents initial distribution shape for chart visualization, while `currentAmount` and `currentValueInQuote` track simulation state
- **Normalization**: Floating-point correction factors ensure exact user-specified token amounts are distributed

## Technology Stack

- Next.js 15.3.3 with static export (`output: 'export'`)
- React 18 with TypeScript
- Tailwind CSS + shadcn/ui components
- Recharts for data visualization
- Firebase integration
- Genkit AI toolkit (@genkit-ai/googleai, @genkit-ai/next)

## Build Configuration

- TypeScript errors and ESLint warnings are ignored during builds (`ignoreBuildErrors: true`, `ignoreDuringBuilds: true`)
- Configured for static site generation (GitHub Pages deployment)
- Path alias: `@/*` maps to `./src/*`

## Important Implementation Details

- The application uses a pristine state check to display exact input values when current price equals initial price
- Chart extends one bin beyond user-defined range to allow out-of-range analysis
- Small amounts (< 1e-12) are treated as dust and filtered out in analysis
- Custom number formatting handles very small values with subscript notation for leading zeros
