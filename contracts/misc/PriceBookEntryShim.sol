// SPDX-License-Identifier: LicenseRef-Rome-Protocol
pragma solidity ^0.8.20;

/// @notice Read surface of the Rome PriceBook (rome-solidity contracts/oracle/PriceBook.sol).
interface IPriceBookEntryView {
  function entryOf(bytes32 sourceAccount)
    external
    view
    returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status);
}

/// @title PriceBookEntryShim
/// @notice One Aave V2-style price source (`latestAnswer()`, 8 decimals) that reads a PriceBook entry
///         DIRECTLY, with a fixed fallback price stored in the shim itself.
///
///         Why it exists: BookFeedToV2ShimResilient reads AaveOracle -> shim -> */USD-BOOK adapter -> PriceBook,
///         and the adapter is an EIP-1167 clone, so each price touches the clone and its implementation as extra
///         Solana accounts. A borrow with several collateral assets then passes Rome's 63-account limit.
///         This shim makes the single call `PriceBook.entryOf(sourceAccount)` and nothing else: no adapter, no
///         fallback aggregator contract, no storage reads (everything it needs is immutable bytecode).
///
///         Validity rules are the ones BookFeedAdapter.latestRoundData applies on read, with the adapter's revert
///         turned into the fixed fallback:
///           status 0 (entry never written)            -> fallback
///           status 2 (feed paused by the book owner)  -> fallback
///           publishTime in the future                 -> fallback
///           now - publishTime > maxStaleness          -> fallback
///           answer <= 0                               -> fallback
///         The confidence bound (maxConfBps) is enforced by the PriceBook when it WRITES an entry: a price whose
///         confidence is too wide is never committed, the previous entry keeps serving until it ages past
///         maxStaleness, and then this shim falls back. So a too-wide confidence reaches the shim as "stale",
///         exactly as it does for the adapter, and needs no extra read here.
///
///         Net behavior: valid entry -> live price; anything else -> the fixed price, never a market-wide revert.
contract PriceBookEntryShim {
  IPriceBookEntryView public immutable book; // PriceBook
  bytes32 public immutable sourceAccount; // the feed's Pyth source account (the PriceBook entry key)
  uint256 public immutable maxStaleness; // seconds; the same bound the feed's BOOK adapter uses
  int256 public immutable fallbackPrice; // 8 decimals, fixed at deploy

  constructor(address _book, bytes32 _sourceAccount, uint256 _maxStaleness, int256 _fallbackPrice) {
    require(_book != address(0) && _book.code.length > 0, "book not a contract");
    require(_sourceAccount != bytes32(0), "zero source");
    require(_maxStaleness >= 1 && _maxStaleness <= 24 hours, "staleness range");
    require(_fallbackPrice > 0, "fallback must be positive");
    book = IPriceBookEntryView(_book);
    sourceAccount = _sourceAccount;
    maxStaleness = _maxStaleness;
    fallbackPrice = _fallbackPrice;
  }

  /// @notice The Aave V2 aggregator read: live PriceBook price when the entry is valid, else `fallbackPrice`.
  function latestAnswer() external view returns (int256) {
    try book.entryOf(sourceAccount) returns (int256 answer, uint64 publishTime, uint64, uint8 status) {
      if (
        status == 1 && answer > 0 && publishTime <= block.timestamp
          && block.timestamp - publishTime <= maxStaleness
      ) return answer;
    } catch {
      // book unreachable: fall through to the fixed price
    }
    return fallbackPrice;
  }

  function decimals() external pure returns (uint8) {
    return 8;
  }
}
