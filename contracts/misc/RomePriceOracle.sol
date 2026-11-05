// SPDX-License-Identifier: LicenseRef-Rome-Protocol
pragma solidity ^0.8.20;

import {IPriceOracleGetter} from '../interfaces/IPriceOracleGetter.sol';

/// @notice Read surface of the Rome PriceBook (rome-solidity contracts/oracle/PriceBook.sol).
interface IPriceBookReader {
  function entryOf(
    bytes32 sourceAccount
  ) external view returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status);
}

/// @title RomePriceOracle
/// @notice ONE price oracle for the Aave pool on Rome, replacing AaveOracle + one source contract per asset.
///
///         Why: on Solana every contract a call touches is an account, and Rome's SDK takes at most 63 accounts
///         per transaction. With AaveOracle each price touches AaveOracle, its per-asset source storage, the
///         source contract and then the PriceBook entry. Here the pool calls this one contract, which reads the
///         PriceBook entry directly and keeps everything else (entry key, staleness bound, fixed fallback price,
///         asset list) in immutable bytecode: no storage reads, no per-asset contract hops, one PriceBook.
///
///         What the pool, PoolConfigurator/ValidationLogic (via GenericLogic), LiquidationLogic,
///         LiquidationDataProvider and UiPoolDataProviderV3 call on the oracle is implemented, and nothing else:
///           IPriceOracleGetter: getAssetPrice, BASE_CURRENCY, BASE_CURRENCY_UNIT
///           IAaveOracle getters: getAssetsPrices, getSourceOfAsset, getFallbackOracle
///         The IAaveOracle setters (setAssetSources, setFallbackOracle) and ADDRESSES_PROVIDER are not
///         implemented: nothing in the vendored v3.6 code calls them on the oracle, and the asset list is fixed
///         at deploy. To change it, deploy a new RomePriceOracle and call PoolAddressesProvider.setPriceOracle.
///
///         Price rules per asset: the validity rules of PriceBookEntryShim
///           status != 1 (never written / paused)   -> fixed fallback
///           publishTime in the future              -> fixed fallback
///           now - publishTime > maxStaleness       -> fixed fallback
///           answer <= 0                            -> fixed fallback
///           book call reverts                      -> fixed fallback
///         otherwise the entry's 8-decimal answer. The fallback is a fixed price chosen at deploy,
///         so a stalled book never reverts the market.
///
///         Unknown asset: reverts. AaveOracle behaves the same on Hadrian, where it has no fallback oracle
///         (getFallbackOracle() == 0): the call to the missing fallback oracle reverts. BASE_CURRENCY is the zero
///         address (USD), as in AaveOracle, and the zero address prices at BASE_CURRENCY_UNIT.
contract RomePriceOracle is IPriceOracleGetter {
  error UnknownAsset(address asset);
  error BadConfig(string why);

  /// @dev One asset's entry in the constructor.
  struct AssetConfig {
    address asset; // the underlying token (pool reserve) address
    bytes32 sourceAccount; // the PriceBook entry key (the feed's Pyth source account)
    uint32 maxStaleness; // seconds; the bound the feed's BOOK adapter uses (1 ..= 24 hours)
    int256 fallbackPrice; // 8 decimals, fixed at deploy, > 0
  }

  IPriceBookReader public immutable book;
  address public constant override BASE_CURRENCY = address(0);
  uint256 public constant override BASE_CURRENCY_UNIT = 1e8;

  // Four slots: wUSDC, wETH, wSOL, wBTC (the order the deploy script passes). Immutables are bytecode constants.
  address private immutable A0;
  address private immutable A1;
  address private immutable A2;
  address private immutable A3;
  bytes32 private immutable K0;
  bytes32 private immutable K1;
  bytes32 private immutable K2;
  bytes32 private immutable K3;
  uint32 private immutable S0;
  uint32 private immutable S1;
  uint32 private immutable S2;
  uint32 private immutable S3;
  int256 private immutable F0;
  int256 private immutable F1;
  int256 private immutable F2;
  int256 private immutable F3;

  constructor(address _book, AssetConfig[4] memory c) {
    if (_book == address(0) || _book.code.length == 0) revert BadConfig('book not a contract');
    for (uint256 i = 0; i < 4; i++) {
      if (c[i].asset == address(0)) revert BadConfig('zero asset');
      if (c[i].sourceAccount == bytes32(0)) revert BadConfig('zero source');
      if (c[i].maxStaleness < 1 || c[i].maxStaleness > 24 hours) revert BadConfig('staleness range');
      if (c[i].fallbackPrice <= 0) revert BadConfig('fallback must be positive');
      for (uint256 j = 0; j < i; j++) if (c[j].asset == c[i].asset) revert BadConfig('duplicate asset');
    }
    book = IPriceBookReader(_book);
    A0 = c[0].asset; K0 = c[0].sourceAccount; S0 = c[0].maxStaleness; F0 = c[0].fallbackPrice;
    A1 = c[1].asset; K1 = c[1].sourceAccount; S1 = c[1].maxStaleness; F1 = c[1].fallbackPrice;
    A2 = c[2].asset; K2 = c[2].sourceAccount; S2 = c[2].maxStaleness; F2 = c[2].fallbackPrice;
    A3 = c[3].asset; K3 = c[3].sourceAccount; S3 = c[3].maxStaleness; F3 = c[3].fallbackPrice;
  }

  /// @inheritdoc IPriceOracleGetter
  function getAssetPrice(address asset) public view override returns (uint256) {
    if (asset == BASE_CURRENCY) return BASE_CURRENCY_UNIT;
    (bytes32 key, uint32 maxStale, int256 fb) = _config(asset);
    return _price(key, maxStale, fb);
  }

  /// @notice Same as AaveOracle.getAssetsPrices.
  function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory prices) {
    prices = new uint256[](assets.length);
    for (uint256 i = 0; i < assets.length; i++) prices[i] = getAssetPrice(assets[i]);
  }

  /// @notice AaveOracle returns the per-asset source contract. There is none here: this contract is the source
  ///         for its four assets (UiPoolDataProviderV3 only shows it as `priceOracle`), zero for any other asset.
  function getSourceOfAsset(address asset) external view returns (address) {
    return _isListed(asset) ? address(this) : address(0);
  }

  /// @notice No fallback oracle: the fallback is the fixed price per asset (as AaveOracle on Hadrian).
  function getFallbackOracle() external pure returns (address) {
    return address(0);
  }

  /// @notice What this oracle holds for `asset`, for scripts and audits. Reverts for an unknown asset.
  function assetConfig(address asset) external view returns (bytes32 sourceAccount, uint32 maxStaleness, int256 fallbackPrice) {
    return _config(asset);
  }

  function _isListed(address a) private view returns (bool) {
    return a == A0 || a == A1 || a == A2 || a == A3;
  }

  function _config(address a) private view returns (bytes32, uint32, int256) {
    if (a == A0) return (K0, S0, F0);
    if (a == A1) return (K1, S1, F1);
    if (a == A2) return (K2, S2, F2);
    if (a == A3) return (K3, S3, F3);
    revert UnknownAsset(a);
  }

  /// @dev PriceBookEntryShim.latestAnswer, with the result as uint256.
  function _price(bytes32 key, uint32 maxStale, int256 fb) private view returns (uint256) {
    try book.entryOf(key) returns (int256 answer, uint64 publishTime, uint64, uint8 status) {
      if (
        status == 1 && answer > 0 && publishTime <= block.timestamp
          && block.timestamp - publishTime <= maxStale
      ) return uint256(answer);
    } catch {
      // book unreachable: fall through to the fixed price
    }
    return uint256(fb);
  }
}
