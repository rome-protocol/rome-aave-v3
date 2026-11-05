// SPDX-License-Identifier: LicenseRef-Rome-Protocol
pragma solidity ^0.8.20;

interface IPriceBookReadRef {
  function entryOf(bytes32 sourceAccount)
    external
    view
    returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status);
}

/// Reference copy of the read path of rome-solidity contracts/oracle/BookFeedAdapter.sol (latestRoundData),
/// without the clone/initializer plumbing, so tests can prove PriceBookEntryShim agrees with the real adapter.
contract BookFeedAdapterRef {
  address public immutable book;
  bytes32 public immutable sourceAccount;
  uint256 public immutable maxStaleness;

  error StalePriceFeed();
  error UninitializedPriceFeed();
  error AdapterPaused();

  constructor(address _book, bytes32 _sourceAccount, uint256 _maxStaleness) {
    book = _book;
    sourceAccount = _sourceAccount;
    maxStaleness = _maxStaleness;
  }

  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    (int256 a, uint64 publishTime,, uint8 status) = IPriceBookReadRef(book).entryOf(sourceAccount);
    if (status == 2) revert AdapterPaused();
    if (status == 0) revert UninitializedPriceFeed();
    if (publishTime > block.timestamp || block.timestamp - publishTime > maxStaleness) revert StalePriceFeed();
    answer = a;
    roundId = 1;
    startedAt = uint256(publishTime);
    updatedAt = uint256(publishTime);
    answeredInRound = 1;
  }
}
