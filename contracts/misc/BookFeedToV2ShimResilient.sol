// SPDX-License-Identifier: LicenseRef-Rome-Protocol
pragma solidity ^0.8.0;

interface IAggregatorV3Like {
  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IAggregatorV2Like {
  function latestAnswer() external view returns (int256);
}

/// @title BookFeedToV2ShimResilient
/// @notice Bridges a Chainlink-V3 feed (Rome PriceBook BookFeedAdapter) to
///         Aave V3's V2 `latestAnswer()`, with a graceful fallback.
///
///         Tries the BOOK adapter (keeper-pushed aggregated price). It reverts
///         StalePriceFeed past maxStaleness; that would revert
///         AaveOracle.getAssetPrice and break the whole market, so on ANY
///         revert (or non-positive answer) this shim falls back to the
///         constant aggregator's latestAnswer(). Both are 8-dec (AaveOracle 1e8).
///
///         Net behavior: fresh feed → live price; stale feed → the constant,
///         never a market-wide revert.
contract BookFeedToV2ShimResilient {
  IAggregatorV3Like public immutable primary; // BookFeedAdapter (Chainlink V3)
  IAggregatorV2Like public immutable fallbackSource; // constant aggregator

  constructor(address _primary, address _fallback) {
    require(_primary != address(0) && _fallback != address(0), "zero addr");
    primary = IAggregatorV3Like(_primary);
    fallbackSource = IAggregatorV2Like(_fallback);
  }

  function latestAnswer() external view returns (int256) {
    try primary.latestRoundData() returns (uint80, int256 answer, uint256, uint256, uint80) {
      if (answer > 0) return answer;
    } catch {
      // stale / paused / low-confidence / non-positive — fall through
    }
    return fallbackSource.latestAnswer();
  }

  function decimals() external pure returns (uint8) {
    return 8;
  }
}
