// SPDX-License-Identifier: LicenseRef-Rome-Protocol
pragma solidity ^0.8.10;

/// Test double for a PriceBook BOOK adapter (Chainlink V3). `stale` makes it revert like StalePriceFeed.
contract MockBookAdapter {
  int256 public answer;
  bool public stale;

  constructor(int256 _answer) {
    answer = _answer;
  }

  function set(int256 _answer, bool _stale) external {
    answer = _answer;
    stale = _stale;
  }

  function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
    require(!stale, "StalePriceFeed");
    return (1, answer, block.timestamp, block.timestamp, 1);
  }

  function decimals() external pure returns (uint8) {
    return 8;
  }
}
