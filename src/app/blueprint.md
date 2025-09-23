# Meteora DLMM Position Simulator

This document outlines the features and functionality of the Meteora DLMM (Dynamic Liquidity Market Maker) Position Simulator.

## Core Features

The simulator allows users to model and analyze a liquidity position in a Meteora DLMM pool.

### 1. Position Configuration

Users can define their liquidity position using the following parameters:

-   **Pool Parameters**:
    -   **Bin Step (bps)**: The price difference between discrete liquidity bins in basis points.
-   **Liquidity Position**:
    -   **Strategy**: The distribution shape for the initial liquidity.
        -   `Spot`: Uniform distribution.
        -   `Bid-Ask`: Triangular distribution, concentrated towards the initial price.
        -   `Curve`: A smoother, curved distribution.
    -   **Price Range**: The minimum and maximum price for the liquidity position.
    -   **Base Token Amount**: The total amount of the base asset (e.g., SOL) to provide.
    -   **Quote Token Amount**: The total amount of the quote asset (e.g., USDC) to provide.
    -   **Initial Price**: The starting price of the assets in the pool.

### 2. Interactive Liquidity Chart

A dynamic chart visualizes the liquidity distribution across the price range.

-   **Bin Visualization**: Each vertical bar represents a discrete liquidity bin.
    -   **Base Token Bins**: Bins containing the base asset are colored purple (`--color-base`).
    -   **Quote Token Bins**: Bins containing the quote asset are colored teal (`--color-quote`).
-   **Dynamic Price Simulation**:
    -   A draggable "Current Price" handle allows users to simulate price movements.
    -   As the price handle moves across the bins, the chart dynamically updates the token type and value within each bin, simulating asset swaps.
    -   The slider snaps to the center price of each discrete bin for precision.
    -   The draggable range extends one bin beyond the user's defined price range to allow for analysis of out-of-range scenarios.
-   **Initial Price Slider**: A separate slider allows for adjusting the initial price of the position, which recalculates the entire initial distribution.

### 3. Position Analysis

A comprehensive analysis panel provides key metrics that update in real-time as the "Current Price" is adjusted.

-   **Initial Position Value**: The total value of the position in the quote token at the `initialPrice`.
-   **Current Position Value**: The total value of the position at the `currentPrice`.
-   **Position Value Change**: The percentage change between the initial and current position values.
-   **Profit/Loss**: The absolute difference in value between the initial and current positions.
-   **Price Pct. Change**: The percentage change between the `initialPrice` and `currentPrice`.
-   **Token Amounts**:
    -   Current total amount of **Base Tokens**.
    -   Current total amount of **Quote Tokens**.
-   **Bin Counts**:
    -   **Total Bins**: The total number of active liquidity bins.
    -   **Base Bins**: The number of bins currently holding the base token.
    -   **Quote Bins**: The number of bins currently holding the quote token.

### 4. UI/UX Features

-   **Clear All**: A button to reset all parameters to their default state.
-   **Responsive Design**: The layout adjusts for different screen sizes.
-   **Custom Styling**: The application uses a dark theme with specific brand colors for base and quote tokens to match the Meteora aesthetic.
-   **Custom Icons**: Icons are used to visually label input fields like Bin Step and Strategy.
