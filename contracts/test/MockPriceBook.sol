// SPDX-License-Identifier: LicenseRef-Rome-Protocol
pragma solidity ^0.8.20;

/// Test double for the PriceBook entry view (same entryOf shape and packing as rome-solidity PriceBook).
contract MockPriceBook {
  mapping(bytes32 => uint256) internal _entries; // price8 int64 | publishTime u64 <<64 | cachedAt u64 <<128 | status u8 <<192
  bool public broken; // entryOf reverts

  function setEntry(bytes32 acct, int64 price8, uint64 publishTime, uint8 status) external {
    _entries[acct] = uint256(uint64(price8)) | (uint256(publishTime) << 64) | (uint256(uint64(block.timestamp)) << 128)
      | (uint256(status) << 192);
  }

  function setBroken(bool b) external {
    broken = b;
  }

  function entryOf(bytes32 acct) external view returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status) {
    require(!broken, "book down");
    uint256 packed = _entries[acct];
    answer = int256(int64(uint64(packed)));
    publishTime = uint64(packed >> 64);
    cachedAt = uint64(packed >> 128);
    status = uint8(packed >> 192);
  }
}
